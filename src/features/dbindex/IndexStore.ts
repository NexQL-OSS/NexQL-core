import * as vscode from 'vscode';
import { IndexManifest, ObjectEntry, TokenIndex, JoinGraph, IndexOverrides, JoinEdge, ForeignKeyEntry } from './types';
import { migrateManifest } from './indexFormat';
import { tokenize } from './lexical';

export function safeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class IndexStore {
  private readonly shardCache = new Map<string, { entries: Record<string, ObjectEntry>; timestamp: number }>();
  private readonly MAX_CACHED_SHARDS = 16;
  private readonly overridesCache = new Map<string, IndexOverrides | null>();

  constructor(public readonly globalStorageUri: vscode.Uri) {}

  public getBaseDir(connectionId: string, database: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this.globalStorageUri,
      'dbindex',
      safeSegment(connectionId),
      safeSegment(database)
    );
  }

  /**
   * Enumerate every built index by reading each manifest (dir segments are lossy, so the real
   * connectionId/database are taken from the manifest). Pure disk reads — no DB connections.
   */
  public async listIndexedDatabases(): Promise<Array<{ connectionId: string; database: string }>> {
    const results: Array<{ connectionId: string; database: string }> = [];
    const root = vscode.Uri.joinPath(this.globalStorageUri, 'dbindex');

    let connDirs: [string, vscode.FileType][];
    try {
      connDirs = await vscode.workspace.fs.readDirectory(root);
    } catch {
      return results; // no index root yet
    }

    for (const [connSeg, connType] of connDirs) {
      if (connType !== vscode.FileType.Directory) { continue; }
      const connUri = vscode.Uri.joinPath(root, connSeg);
      let dbDirs: [string, vscode.FileType][];
      try {
        dbDirs = await vscode.workspace.fs.readDirectory(connUri);
      } catch {
        continue;
      }
      for (const [dbSeg, dbType] of dbDirs) {
        if (dbType !== vscode.FileType.Directory) { continue; }
        const manifest = await this.readManifest(vscode.Uri.joinPath(connUri, dbSeg));
        if (manifest && manifest.connectionId && manifest.database) {
          results.push({ connectionId: manifest.connectionId, database: manifest.database });
        }
      }
    }
    return results;
  }

  /**
   * Acquire a build lock to prevent concurrent build tasks.
   * If a lock exists and is older than 10 minutes, it is ignored/overwritten.
   */
  public async acquireLock(baseDir: vscode.Uri): Promise<boolean> {
    const lockUri = vscode.Uri.joinPath(baseDir, '.lock');
    const now = Date.now();
    try {
      const info = await vscode.workspace.fs.stat(lockUri);
      // Check if lock file is older than 10 minutes (600,000ms)
      const mtime = info.mtime;
      if (now - mtime > 10 * 60 * 1000) {
        // Abandoned lock, overwrite it
        await this.writeLockFile(lockUri);
        return true;
      }
      return false;
    } catch {
      // Lock doesn't exist, create it
      await this.writeLockFile(lockUri);
      return true;
    }
  }

  private async writeLockFile(lockUri: vscode.Uri): Promise<void> {
    const data = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
    await vscode.workspace.fs.writeFile(lockUri, Buffer.from(data, 'utf-8'));
  }

  public async releaseLock(baseDir: vscode.Uri): Promise<void> {
    const lockUri = vscode.Uri.joinPath(baseDir, '.lock');
    try {
      await vscode.workspace.fs.delete(lockUri, { recursive: false, useTrash: false });
    } catch {
      // ignore if already deleted
    }
  }

  public async readManifest(baseDir: vscode.Uri): Promise<IndexManifest | null> {
    const manifestUri = vscode.Uri.joinPath(baseDir, 'manifest.json');
    try {
      const data = await vscode.workspace.fs.readFile(manifestUri);
      const rawJson = Buffer.from(data).toString('utf-8');
      return migrateManifest(rawJson);
    } catch {
      return null;
    }
  }

  public async readTokens(baseDir: vscode.Uri, manifest: IndexManifest): Promise<TokenIndex | null> {
    const tokensUri = vscode.Uri.joinPath(baseDir, manifest.derived.tokens);
    try {
      const data = await vscode.workspace.fs.readFile(tokensUri);
      const tokenIndex = JSON.parse(Buffer.from(data).toString('utf-8')) as TokenIndex;
      
      const overrides = await this.readOverrides(baseDir);
      if (overrides) {
        // 1. Merge custom synonyms
        if (overrides.synonyms) {
          if (!tokenIndex.synonyms) {
            tokenIndex.synonyms = {};
          }
          for (const [word, syns] of Object.entries(overrides.synonyms)) {
            const baseSyns = tokenIndex.synonyms[word] || [];
            tokenIndex.synonyms[word] = Array.from(new Set([...baseSyns, ...syns]));
          }
        }

        // 2. Tokenize and inject override descriptions into postings
        if (overrides.objects) {
          for (const [ref, obj] of Object.entries(overrides.objects)) {
            if (obj.comment) {
              const tokens = tokenize(obj.comment);
              for (const token of tokens) {
                if (!tokenIndex.postings[token]) {
                  tokenIndex.postings[token] = [];
                }
                const postings = tokenIndex.postings[token];
                const match = postings.find(p => p[0] === ref);
                if (!match) {
                  postings.push([ref, 1.5]); // Moderate weight for comment terms
                }
                if (!tokenIndex.df[token]) {
                  tokenIndex.df[token] = 0;
                }
                tokenIndex.df[token]++;
              }
            }
            if (obj.columns) {
              for (const [colName, col] of Object.entries(obj.columns)) {
                if (col.comment) {
                  const tokens = tokenize(col.comment);
                  for (const token of tokens) {
                    if (!tokenIndex.postings[token]) {
                      tokenIndex.postings[token] = [];
                    }
                    const postings = tokenIndex.postings[token];
                    const match = postings.find(p => p[0] === ref);
                    if (!match) {
                      postings.push([ref, 1.0]); // Standard weight for column comment terms
                    }
                    if (!tokenIndex.df[token]) {
                      tokenIndex.df[token] = 0;
                    }
                    tokenIndex.df[token]++;
                  }
                }
              }
            }
          }
        }
      }
      return tokenIndex;
    } catch {
      return null;
    }
  }

  public async readJoinGraph(baseDir: vscode.Uri, manifest: IndexManifest): Promise<JoinGraph | null> {
    const jgUri = vscode.Uri.joinPath(baseDir, manifest.derived.joinGraph);
    try {
      const data = await vscode.workspace.fs.readFile(jgUri);
      const graph = JSON.parse(Buffer.from(data).toString('utf-8')) as JoinGraph;
      
      const overrides = await this.readOverrides(baseDir);
      if (overrides?.joins && overrides.joins.length > 0) {
        const overrideMap = new Map<string, JoinEdge>();
        for (const edge of overrides.joins) {
          const key = `${edge.from}->${edge.to}:${edge.via}`;
          overrideMap.set(key, edge);
        }

        const mergedEdges: JoinEdge[] = [];
        for (const baseEdge of graph.edges) {
          const key = `${baseEdge.from}->${baseEdge.to}:${baseEdge.via}`;
          if (overrideMap.has(key)) {
            const override = overrideMap.get(key)!;
            if (!override.disabled) {
              mergedEdges.push(override);
            }
            overrideMap.delete(key);
          } else {
            mergedEdges.push(baseEdge);
          }
        }

        for (const edge of overrideMap.values()) {
          if (!edge.disabled) {
            mergedEdges.push(edge);
          }
        }

        graph.edges = mergedEdges;
      }
      return graph;
    } catch {
      return null;
    }
  }

  public async readValues(
    baseDir: vscode.Uri,
    manifest: IndexManifest
  ): Promise<Record<string, { ref: string; col: string }[]> | null> {
    if (!manifest.derived.values) {
      return null;
    }
    const valuesUri = vscode.Uri.joinPath(baseDir, manifest.derived.values);
    try {
      const data = await vscode.workspace.fs.readFile(valuesUri);
      return JSON.parse(Buffer.from(data).toString('utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Lazily loads an object entry from sharded files, with LRU caching.
   * Key is `schema.object_name`.
   */
  public async getObjectEntry(
    baseDir: vscode.Uri,
    manifest: IndexManifest,
    schema: string,
    objectName: string
  ): Promise<ObjectEntry | null> {
    const ref = `${schema}.${objectName}`;
    const shardInfo = manifest.shards.find(s => s.schema === schema);
    if (!shardInfo) {
      return null;
    }

    const shardFile = shardInfo.file;
    const cacheKey = `${baseDir.toString()}#${shardFile}`;
    let cached = this.shardCache.get(cacheKey);

    if (!cached) {
      const shardUri = vscode.Uri.joinPath(baseDir, shardFile);
      try {
        const data = await vscode.workspace.fs.readFile(shardUri);
        const entries = JSON.parse(Buffer.from(data).toString('utf-8')) as Record<string, ObjectEntry>;
        cached = { entries, timestamp: Date.now() };
        
        // LRU evict if cache is too large
        if (this.shardCache.size >= this.MAX_CACHED_SHARDS) {
          let oldestKey = '';
          let oldestTime = Infinity;
          for (const [k, v] of this.shardCache.entries()) {
            if (v.timestamp < oldestTime) {
              oldestTime = v.timestamp;
              oldestKey = k;
            }
          }
          if (oldestKey) {
            this.shardCache.delete(oldestKey);
          }
        }
        
        this.shardCache.set(cacheKey, cached);
      } catch {
        return null;
      }
    } else {
      cached.timestamp = Date.now();
    }

    const entry = cached.entries[ref];
    if (!entry) {
      return null;
    }

    const overrides = await this.readOverrides(baseDir);
    if (!overrides) {
      return entry;
    }

    // Clone to prevent mutating cached entries directly
    const cloned: ObjectEntry = JSON.parse(JSON.stringify(entry));

    const objOverride = overrides.objects?.[ref];
    if (objOverride) {
      if (objOverride.comment !== undefined) {
        cloned.comment = objOverride.comment;
      }
      if (objOverride.excluded !== undefined) {
        cloned.excluded = objOverride.excluded;
      }
      if (objOverride.columns) {
        for (const col of cloned.columns) {
          const colOverride = objOverride.columns[col.name];
          if (colOverride) {
            if (colOverride.comment !== undefined) {
              col.comment = colOverride.comment;
            }
            if (colOverride.pii !== undefined) {
              col.pii = colOverride.pii;
            }
          }
        }
      }
    }

    // Merge custom/disabled joins into cloned.foreignKeys
    if (overrides.joins) {
      if (!cloned.foreignKeys) {
        cloned.foreignKeys = [];
      }
      for (const edge of overrides.joins) {
        if (edge.disabled) {
          cloned.foreignKeys = cloned.foreignKeys.filter(fk => {
            const matches = fk.columns[0] === edge.cols[0]?.[0] && fk.refTable === edge.to;
            return !matches;
          });
          continue;
        }

        if (edge.from === ref) {
          const existingIdx = cloned.foreignKeys.findIndex(fk => fk.refTable === edge.to && fk.columns[0] === edge.cols[0]?.[0]);
          const newFk: ForeignKeyEntry = {
            columns: edge.cols.map(c => c[0]),
            refTable: edge.to,
            refColumns: edge.cols.map(c => c[1]),
            name: edge.via,
            inferred: edge.inferred
          };
          if (existingIdx >= 0) {
            cloned.foreignKeys[existingIdx] = newFk;
          } else {
            cloned.foreignKeys.push(newFk);
          }
        }
      }
    }

    return cloned;
  }

  /**
   * Atomic file writing helper. Writes to a `.tmp` file and replaces the target.
   */
  public async writeAtomic(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const parentDir = vscode.Uri.joinPath(uri, '..');
    try {
      await vscode.workspace.fs.createDirectory(parentDir);
    } catch {
      // directory might already exist
    }

    const tmpUri = vscode.Uri.parse(uri.toString() + '.tmp');
    await vscode.workspace.fs.writeFile(tmpUri, content);
    await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
  }

  /**
   * Cleans up any index files in baseDir that are not referenced in the manifest.
   */
  public async runGarbageCollection(baseDir: vscode.Uri, manifest: IndexManifest): Promise<void> {
    try {
      const files = await vscode.workspace.fs.readDirectory(baseDir);
      const activeFiles = new Set<string>([
        'manifest.json',
        manifest.derived.tokens,
        manifest.derived.joinGraph,
      ]);
      if (manifest.derived.embeddings) {
        activeFiles.add(manifest.derived.embeddings);
      }
      if (manifest.derived.embeddingsMeta) {
        activeFiles.add(manifest.derived.embeddingsMeta);
      }
      for (const shard of manifest.shards) {
        activeFiles.add(shard.file);
      }

      for (const [filename, filetype] of files) {
        if (filetype === vscode.FileType.File && !activeFiles.has(filename) && filename !== '.lock') {
          const deleteUri = vscode.Uri.joinPath(baseDir, filename);
          await vscode.workspace.fs.delete(deleteUri, { recursive: false, useTrash: false });
        }
      }
    } catch {
      // ignore GC errors
    }
  }

  /**
   * Delete all index files for a database.
   */
  public async clearIndex(connectionId: string, database: string): Promise<void> {
    const baseDir = this.getBaseDir(connectionId, database);
    try {
      await vscode.workspace.fs.delete(baseDir, { recursive: true, useTrash: false });
      // clear memory cache as well
      const prefix = baseDir.toString();
      for (const key of this.shardCache.keys()) {
        if (key.startsWith(prefix)) {
          this.shardCache.delete(key);
        }
      }
      this.overridesCache.delete(baseDir.toString());
    } catch {
      // ignore if folder doesn't exist
    }
  }

  public async readOverrides(baseDir: vscode.Uri): Promise<IndexOverrides | null> {
    const cacheKey = baseDir.toString();
    if (this.overridesCache.has(cacheKey)) {
      return this.overridesCache.get(cacheKey)!;
    }

    const overridesUri = vscode.Uri.joinPath(baseDir, 'overrides.json');
    try {
      const data = await vscode.workspace.fs.readFile(overridesUri);
      const overrides = JSON.parse(Buffer.from(data).toString('utf-8')) as IndexOverrides;
      this.overridesCache.set(cacheKey, overrides);
      return overrides;
    } catch {
      this.overridesCache.set(cacheKey, null);
      return null;
    }
  }

  public async writeOverrides(baseDir: vscode.Uri, overrides: IndexOverrides): Promise<void> {
    const overridesUri = vscode.Uri.joinPath(baseDir, 'overrides.json');
    const content = Buffer.from(JSON.stringify(overrides, null, 2), 'utf-8');
    await this.writeAtomic(overridesUri, content);
    
    // Invalidate caches
    this.overridesCache.set(baseDir.toString(), overrides);
    
    // Clear shardCache as well to force reload of entries with new overrides
    const prefix = baseDir.toString();
    for (const key of this.shardCache.keys()) {
      if (key.startsWith(prefix)) {
        this.shardCache.delete(key);
      }
    }
  }
}
