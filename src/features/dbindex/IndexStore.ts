import * as vscode from 'vscode';
import { IndexManifest, ObjectEntry, TokenIndex, JoinGraph } from './types';
import { migrateManifest } from './indexFormat';

export function safeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class IndexStore {
  private readonly shardCache = new Map<string, { entries: Record<string, ObjectEntry>; timestamp: number }>();
  private readonly MAX_CACHED_SHARDS = 16;

  constructor(private readonly globalStorageUri: vscode.Uri) {}

  public getBaseDir(connectionId: string, database: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this.globalStorageUri,
      'dbindex',
      safeSegment(connectionId),
      safeSegment(database)
    );
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
      return JSON.parse(Buffer.from(data).toString('utf-8')) as TokenIndex;
    } catch {
      return null;
    }
  }

  public async readJoinGraph(baseDir: vscode.Uri, manifest: IndexManifest): Promise<JoinGraph | null> {
    const jgUri = vscode.Uri.joinPath(baseDir, manifest.derived.joinGraph);
    try {
      const data = await vscode.workspace.fs.readFile(jgUri);
      return JSON.parse(Buffer.from(data).toString('utf-8')) as JoinGraph;
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

    return cached.entries[ref] || null;
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
    } catch {
      // ignore if folder doesn't exist
    }
  }
}
