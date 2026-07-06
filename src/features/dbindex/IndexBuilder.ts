import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/ConnectionManager';
import {
  IndexManifest,
  IndexScope,
  BuildDepth,
  BuildMode,
  ObjectEntry,
  TokenIndex,
  JoinGraph,
  ColumnEntry,
  ForeignKeyEntry,
  IndexEntry,
  CheckEntry,
  ObjectShard,
  EmbeddingMetaEntry,
} from './types';
import { ProFeature, isProFeatureEnabled } from '../../services/featureGates';
import {
  RELATIONS_QUERY,
  COLUMNS_QUERY,
  CONSTRAINTS_QUERY,
  INDEXES_QUERY,
  VIEW_DEFINITIONS_QUERY,
  FUNCTIONS_QUERY,
  ENUMS_QUERY,
  DOMAINS_QUERY,
  RawRelationRow,
  RawColumnRow,
  RawConstraintRow,
  RawIndexRow,
  RawViewRow,
  RawFunctionRow,
  RawEnumRow,
  RawDomainRow,
  mapRelkindToDbObjectKind,
  fetchSchemaFingerprint,
} from './catalogQueries';
import { computeObjectHash } from './objectHash';
import { IndexStore } from './IndexStore';
import { tokenize, extractSynonymsFromComment } from './lexical';
import { runValueProfiling } from './valueProfiler';

function isNamingMatch(colPrefix: string, tableName: string): boolean {
  const p = colPrefix.toLowerCase();
  const t = tableName.toLowerCase();
  if (p === t) return true;
  if (t === p + 's') return true;
  if (p === t + 's') return true;
  if (p.endsWith('y') && t === p.slice(0, -1) + 'ies') return true;
  if (t.endsWith('y') && p === t.slice(0, -1) + 'ies') return true;
  if (p.endsWith('ey') && t === p + 's') return true;
  if (p.endsWith('ss') && t === p + 'es') return true;
  if (t.endsWith('ss') && p === t + 'es') return true;
  return false;
}

function buildObjectDoc(ref: string, entry: ObjectEntry): string {
  let doc = `${entry.kind.toUpperCase()}: ${ref}`;
  if (entry.comment) {
    doc += `\nDescription: ${entry.comment}`;
  }
  const colList = entry.columns.map(c => {
    let colDesc = `${c.name} (${c.type})`;
    if (c.comment) {
      colDesc += ` - ${c.comment}`;
    }
    return colDesc;
  }).join(', ');
  doc += `\nColumns: ${colList}`;
  if (entry.primaryKey && entry.primaryKey.length > 0) {
    doc += `\nPrimary Key: ${entry.primaryKey.join(', ')}`;
  }
  return doc;
}

export class IndexBuilder {
  constructor(private readonly store: IndexStore) {}

  public async build(
    connectionId: string,
    database: string,
    scope: IndexScope,
    depth: BuildDepth,
    buildMode: BuildMode,
    environment: string,
    cancellationToken?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<IndexManifest> {
    const baseDir = this.store.getBaseDir(connectionId, database);
    const startBuild = Date.now();

    // 1. Get connection configuration
    const connections: any[] = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
    const connection = connections.find(c => c.id === connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found in configuration`);
    }

    // 2. Fetch connection client from ConnectionManager pool
    const client = await ConnectionManager.getInstance().getPooledClient({
      ...connection,
      database,
    });

    let queriesRun = 0;
    const warnings: string[] = [];
    let schemaFingerprint = '';
    let pgVersion = '';

    try {
      // Set a statement timeout of 5 seconds to avoid hanging locks
      await client.query("SET statement_timeout = 5000");
      queriesRun++;

      // Cancel check
      this.checkCancelled(cancellationToken);

      // 3. Get schema fingerprint and pg version
      schemaFingerprint = await fetchSchemaFingerprint(client);
      queriesRun++;

      const versionResult = await client.query("SHOW server_version");
      queriesRun++;
      pgVersion = versionResult.rows[0]?.server_version?.split(' ')[0] || '16.0';

      this.checkCancelled(cancellationToken);

      // 4. Batch query structural elements
      const schemas = scope.includedSchemas.length > 0 ? scope.includedSchemas : ['public'];

      const relationsResult = await client.query(RELATIONS_QUERY, [schemas]);
      queriesRun++;
      const relations: RawRelationRow[] = relationsResult.rows;

      if (relations.length === 0) {
        throw new Error('No objects found in specified schemas');
      }

      // Filter out excluded objects
      const excludedSet = new Set(scope.excludedObjects);
      const filteredRelations = relations.filter(r => !excludedSet.has(`${r.schema_name}.${r.name}`));

      const oids = filteredRelations.map(r => r.oid);

      // Run bulk queries
      this.checkCancelled(cancellationToken);
      const columnsResult = await client.query(COLUMNS_QUERY, [oids]);
      queriesRun++;
      const columns: RawColumnRow[] = columnsResult.rows;

      this.checkCancelled(cancellationToken);
      const constraintsResult = await client.query(CONSTRAINTS_QUERY, [oids]);
      queriesRun++;
      const constraints: RawConstraintRow[] = constraintsResult.rows;

      this.checkCancelled(cancellationToken);
      const indexesResult = await client.query(INDEXES_QUERY, [oids]);
      queriesRun++;
      const indexes: RawIndexRow[] = indexesResult.rows;

      this.checkCancelled(cancellationToken);
      const viewsResult = await client.query(VIEW_DEFINITIONS_QUERY, [oids]);
      queriesRun++;
      const views: RawViewRow[] = viewsResult.rows;

      this.checkCancelled(cancellationToken);
      const functionsResult = await client.query(FUNCTIONS_QUERY, [schemas]);
      queriesRun++;
      const functions: RawFunctionRow[] = functionsResult.rows;

      this.checkCancelled(cancellationToken);
      const enumsResult = await client.query(ENUMS_QUERY, [schemas]);
      queriesRun++;
      const enums: RawEnumRow[] = enumsResult.rows;

      this.checkCancelled(cancellationToken);
      const domainsResult = await client.query(DOMAINS_QUERY, [schemas]);
      queriesRun++;
      const domains: RawDomainRow[] = domainsResult.rows;

      this.checkCancelled(cancellationToken);

      // 5. Structure mappings into ObjectEntry maps
      const entriesMap: Record<string, ObjectEntry> = {};

      // Map relation rows
      const relationMap = new Map<number, RawRelationRow>();
      for (const rel of filteredRelations) {
        relationMap.set(rel.oid, rel);
        const ref = `${rel.schema_name}.${rel.name}`;
        entriesMap[ref] = {
          kind: mapRelkindToDbObjectKind(rel.kind),
          oid: rel.oid,
          objectHash: '',
          comment: rel.comment,
          rowEstimate: parseInt(String(rel.row_estimate), 10) || 0,
          sizeBytes: parseInt(String(rel.size_bytes), 10) || 0,
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          indexes: [],
          checks: [],
        };
      }

      // Map columns
      const colMap = new Map<number, ColumnEntry[]>();
      for (const col of columns) {
        const refColumn = `${relationMap.get(col.table_oid)?.schema_name}.${relationMap.get(col.table_oid)?.name}.${col.name}`;
        const isPii = scope.piiExcludedColumns.includes(refColumn);

        const colEntry: ColumnEntry = {
          name: col.name,
          type: col.type,
          notNull: col.not_null,
          default: col.default_value,
          comment: col.comment,
          ordinal: col.ordinal,
        };

        let list = colMap.get(col.table_oid);
        if (!list) {
          list = [];
          colMap.set(col.table_oid, list);
        }
        list.push(colEntry);
      }

      for (const [tableOid, cols] of colMap.entries()) {
        const rel = relationMap.get(tableOid);
        if (rel) {
          const entry = entriesMap[`${rel.schema_name}.${rel.name}`];
          if (entry) {
            entry.columns = cols.sort((a, b) => a.ordinal - b.ordinal);
          }
        }
      }

      // Map constraints
      for (const con of constraints) {
        const rel = relationMap.get(con.table_oid);
        if (!rel) continue;
        const entry = entriesMap[`${rel.schema_name}.${rel.name}`];
        if (!entry) continue;

        if (con.type === 'p') {
          // Primary Key
          const pkCols: string[] = [];
          if (con.key_positions && entry.columns) {
            for (const pos of con.key_positions) {
              const col = entry.columns.find(c => c.ordinal === pos);
              if (col) {
                col.isPk = true;
                pkCols.push(col.name);
              }
            }
          }
          entry.primaryKey = pkCols;
        } else if (con.type === 'f') {
          // Foreign Key
          const refRel = relationMap.get(con.ref_table_oid || 0);
          if (refRel && con.key_positions && con.ref_key_positions) {
            const colsList: string[] = [];
            const refColsList: string[] = [];
            for (const pos of con.key_positions) {
              const c = entry.columns.find(x => x.ordinal === pos);
              if (c) colsList.push(c.name);
            }
            const refEntry = entriesMap[`${refRel.schema_name}.${refRel.name}`];
            const refColSource = refEntry?.columns || [];
            for (const pos of con.ref_key_positions) {
              const c = refColSource.find(x => x.ordinal === pos);
              if (c) refColsList.push(c.name);
            }

            const fk: ForeignKeyEntry = {
              name: con.name,
              columns: colsList,
              refTable: `${refRel.schema_name}.${refRel.name}`,
              refColumns: refColsList,
            };
            entry.foreignKeys?.push(fk);
          }
        } else if (con.type === 'c') {
          // CHECK constraint
          const check: CheckEntry = {
            name: con.name,
            expr: con.definition,
          };
          entry.checks?.push(check);
        }
      }

      // Map indexes
      for (const idx of indexes) {
        const rel = relationMap.get(idx.table_oid);
        if (!rel) continue;
        const entry = entriesMap[`${rel.schema_name}.${rel.name}`];
        if (!entry) continue;

        const idxCols: string[] = [];
        if (idx.key_positions) {
          for (const pos of idx.key_positions) {
            const col = entry.columns.find(c => c.ordinal === pos);
            if (col) idxCols.push(col.name);
          }
        }

        const idxEntry: IndexEntry = {
          name: idx.name,
          columns: idxCols,
          unique: idx.unique,
          method: idx.method,
          partial: idx.definition.includes('WHERE') ? idx.definition.split('WHERE')[1]?.trim() : null,
        };
        entry.indexes?.push(idxEntry);
      }

      // Map view definitions
      for (const view of views) {
        const rel = relationMap.get(view.oid);
        if (rel) {
          const entry = entriesMap[`${rel.schema_name}.${rel.name}`];
          if (entry) {
            entry.definition = view.definition;
          }
        }
      }

      // Map functions
      for (const fn of functions) {
        const ref = `${fn.schema_name}.${fn.name}`;
        entriesMap[ref] = {
          kind: 'function',
          oid: fn.oid,
          objectHash: '',
          comment: fn.comment,
          rowEstimate: 0,
          sizeBytes: 0,
          columns: [],
          signature: `${fn.name}(${fn.arguments}) RETURNS ${fn.result_type}`,
          language: fn.language,
          volatility: fn.volatility,
          body: fn.body, // Include body; we can filter it or cap it if it gets too large
        };
      }

      // Map enums
      const enumGroups = new Map<number, RawEnumRow[]>();
      for (const en of enums) {
        let list = enumGroups.get(en.oid);
        if (!list) {
          list = [];
          enumGroups.set(en.oid, list);
        }
        list.push(en);
      }

      for (const [oid, rows] of enumGroups.entries()) {
        const first = rows[0];
        if (first) {
          const ref = `${first.schema_name}.${first.name}`;
          entriesMap[ref] = {
            kind: 'enum',
            oid: oid,
            objectHash: '',
            comment: null,
            rowEstimate: 0,
            sizeBytes: 0,
            columns: [],
            values: rows.map(r => r.value),
          };
        }
      }

      // Map domains
      for (const dom of domains) {
        const ref = `${dom.schema_name}.${dom.name}`;
        entriesMap[ref] = {
          kind: 'domain',
          oid: dom.oid,
          objectHash: '',
          comment: null,
          rowEstimate: 0,
          sizeBytes: 0,
          columns: [],
          baseType: dom.base_type,
          constraint: dom.constraint_definition || undefined,
        };
      }

      // 6. Profiles pass (if depth includes profiles)
      if (depth === 'profiles') {
        this.checkCancelled(cancellationToken);
        const profileCount = await runValueProfiling(client, entriesMap, scope, warnings, cancellationToken);
        queriesRun += profileCount;
      }

      // 7. Calculate Object Hash for all entries
      for (const entry of Object.values(entriesMap)) {
        entry.objectHash = computeObjectHash(entry);
      }

      // 8. Read previous manifest to support incremental build
      const previousManifest = await this.store.readManifest(baseDir);

      // Group entries by schema to compile shards
      const schemaObjects: Record<string, Record<string, ObjectEntry>> = {};
      for (const [ref, entry] of Object.entries(entriesMap)) {
        const schema = ref.split('.')[0] || 'public';
        if (!schemaObjects[schema]) {
          schemaObjects[schema] = {};
        }
        schemaObjects[schema][ref] = entry;
      }

      const shards: ObjectShard[] = [];

      for (const [schema, objects] of Object.entries(schemaObjects)) {
        // Group objects into max 64 objects or 256KB shards
        const objArray = Object.entries(objects);
        let shardIndex = 0;
        let currentShardObjects: Record<string, ObjectEntry> = {};
        let currentShardSize = 0;

        const writeCurrentShard = async () => {
          const file = `objects-${schema}-${shardIndex}.json`;
          const content = JSON.stringify(currentShardObjects);
          const bytes = Buffer.byteLength(content, 'utf-8');
          const hash = computeObjectHash({ definition: content }); // reuse hash function

          // Check if previous shard exists and has identical hash
          const prevShard = previousManifest?.shards.find(s => s.file === file);
          const shardUri = vscode.Uri.joinPath(baseDir, file);

          if (!prevShard || prevShard.hash !== hash) {
            await this.store.writeAtomic(shardUri, Buffer.from(content, 'utf-8'));
          }

          shards.push({
            file,
            schema,
            objects: Object.keys(currentShardObjects).length,
            bytes,
            hash,
          });

          shardIndex++;
          currentShardObjects = {};
          currentShardSize = 0;
        };

        for (const [ref, entry] of objArray) {
          const entryStr = JSON.stringify(entry);
          const entrySize = Buffer.byteLength(entryStr, 'utf-8');

          if (Object.keys(currentShardObjects).length >= 64 || currentShardSize + entrySize > 256 * 1024) {
            await writeCurrentShard();
          }

          currentShardObjects[ref] = entry;
          currentShardSize += entrySize;
        }

        if (Object.keys(currentShardObjects).length > 0) {
          await writeCurrentShard();
        }
      }

      // 9. Derive tokens posting list
      const tokenIndex: TokenIndex = {
        version: 1,
        df: {},
        postings: {},
        synonyms: {},
      };

      for (const [ref, entry] of Object.entries(entriesMap)) {
        const objTokens = new Set<string>();

        // Tokenize relation name
        const namePart = ref.split('.')[1] || ref;
        for (const t of tokenize(namePart)) {
          objTokens.add(t);
          this.addPosting(tokenIndex, t, ref, 3.0);
        }

        // Tokenize comment
        if (entry.comment) {
          for (const t of tokenize(entry.comment)) {
            objTokens.add(t);
            this.addPosting(tokenIndex, t, ref, 0.5);
          }

          // Mine synonyms from relation comment
          const relationSyns = extractSynonymsFromComment(entry.comment);
          for (const synStr of relationSyns) {
            const synTokens = tokenize(synStr);
            const nameTokens = tokenize(namePart);
            for (const st of synTokens) {
              for (const nt of nameTokens) {
                if (!tokenIndex.synonyms[st]) {
                  tokenIndex.synonyms[st] = [];
                }
                if (!tokenIndex.synonyms[st].includes(nt)) {
                  tokenIndex.synonyms[st].push(nt);
                }
                if (!tokenIndex.synonyms[nt]) {
                  tokenIndex.synonyms[nt] = [];
                }
                if (!tokenIndex.synonyms[nt].includes(st)) {
                  tokenIndex.synonyms[nt].push(st);
                }
              }
            }
          }
        }

        // Tokenize columns
        for (const col of entry.columns) {
          const colWeight = col.isPk ? 1.25 : 1.0;
          for (const t of tokenize(col.name)) {
            objTokens.add(t);
            this.addPosting(tokenIndex, t, ref, colWeight);
          }
          if (col.comment) {
            for (const t of tokenize(col.comment)) {
              objTokens.add(t);
              this.addPosting(tokenIndex, t, ref, 0.3);
            }

            // Mine synonyms from column comment
            const colSyns = extractSynonymsFromComment(col.comment);
            for (const synStr of colSyns) {
              const synTokens = tokenize(synStr);
              const colTokens = tokenize(col.name);
              for (const st of synTokens) {
                for (const ct of colTokens) {
                  if (!tokenIndex.synonyms[st]) {
                    tokenIndex.synonyms[st] = [];
                  }
                  if (!tokenIndex.synonyms[st].includes(ct)) {
                    tokenIndex.synonyms[st].push(ct);
                  }
                  if (!tokenIndex.synonyms[ct]) {
                    tokenIndex.synonyms[ct] = [];
                  }
                  if (!tokenIndex.synonyms[ct].includes(st)) {
                    tokenIndex.synonyms[ct].push(st);
                  }
                }
              }
            }
          }
        }

        // Increment document frequencies
        for (const t of objTokens) {
          tokenIndex.df[t] = (tokenIndex.df[t] || 0) + 1;
        }
      }

      const tokensUri = vscode.Uri.joinPath(baseDir, 'tokens.json');
      await this.store.writeAtomic(tokensUri, Buffer.from(JSON.stringify(tokenIndex), 'utf-8'));

      // 9.5 Derive value index (from low-cardinality, non-PII columns)
      const valueIndex: Record<string, { ref: string; col: string }[]> = {};
      for (const [ref, entry] of Object.entries(entriesMap)) {
        for (const col of entry.columns) {
          if (col.profile && col.profile.commonValues) {
            // Check low cardinality
            const isLowCardinality = col.profile.nDistinct > 0 && col.profile.nDistinct <= 20;
            if (isLowCardinality) {
              for (const val of col.profile.commonValues) {
                const valTokens = tokenize(val);
                for (const t of valTokens) {
                  if (!valueIndex[t]) {
                    valueIndex[t] = [];
                  }
                  if (!valueIndex[t].some(x => x.ref === ref && x.col === col.name)) {
                    valueIndex[t].push({ ref, col: col.name });
                  }
                }
              }
            }
          }
        }
      }

      const valuesUri = vscode.Uri.joinPath(baseDir, 'values.json');
      await this.store.writeAtomic(valuesUri, Buffer.from(JSON.stringify(valueIndex), 'utf-8'));

      // 10. Derive join graph
      const joinGraph: JoinGraph = { edges: [] };
      for (const entry of Object.values(entriesMap)) {
        if (entry.foreignKeys) {
          for (const fk of entry.foreignKeys) {
            const sourceTable = Object.keys(entriesMap).find(k => entriesMap[k].oid === entry.oid);
            if (sourceTable) {
              const edgeCols: [string, string][] = fk.columns.map((c, idx) => [c, fk.refColumns[idx] || '']);
              joinGraph.edges.push({
                from: sourceTable,
                to: fk.refTable,
                via: fk.name,
                cols: edgeCols,
              });
            }
          }
        }
      }

      // Infer naming-convention joins when no FK exists
      for (const [refA, entryA] of Object.entries(entriesMap)) {
        if (entryA.kind !== 'table') continue;
        const schemaA = refA.split('.')[0] || 'public';
        const nameA = refA.split('.')[1] || '';

        for (const col of entryA.columns) {
          if (!col.name.toLowerCase().endsWith('_id')) continue;
          const prefix = col.name.slice(0, -3);
          if (!prefix) continue;

          for (const [refB, entryB] of Object.entries(entriesMap)) {
            if (entryB.kind !== 'table' || refA === refB) continue;
            const schemaB = refB.split('.')[0] || 'public';
            if (schemaA !== schemaB) continue; // same schema
            const nameB = refB.split('.')[1] || '';

            if (isNamingMatch(prefix, nameB)) {
              const hasExplicit = entryA.foreignKeys?.some(fk =>
                fk.refTable === refB && fk.columns.includes(col.name)
              );
              if (hasExplicit) continue;

              let targetCol = '';
              if (entryB.primaryKey && entryB.primaryKey.length === 1) {
                targetCol = entryB.primaryKey[0];
              } else if (entryB.columns.some(c => c.name.toLowerCase() === 'id')) {
                targetCol = 'id';
              } else {
                const matchedCol = entryB.columns.find(c => c.name.toLowerCase() === `${nameB.toLowerCase()}_id`);
                if (matchedCol) {
                  targetCol = matchedCol.name;
                }
              }

              if (targetCol) {
                const alreadyAdded = joinGraph.edges.some(e =>
                  e.from === refA && e.to === refB && e.cols.some(c => c[0] === col.name && c[1] === targetCol)
                );
                if (!alreadyAdded) {
                  joinGraph.edges.push({
                    from: refA,
                    to: refB,
                    via: `inferred:${nameA}.${col.name}->${nameB}.${targetCol}`,
                    cols: [[col.name, targetCol]],
                    inferred: true
                  });
                }
              }
            }
          }
        }
      }

      const jgUri = vscode.Uri.joinPath(baseDir, 'joingraph.json');
      await this.store.writeAtomic(jgUri, Buffer.from(JSON.stringify(joinGraph), 'utf-8'));

      // Count mapped objects
      const counts = {
        tables: 0,
        views: 0,
        functions: 0,
        enums: 0,
      };

      for (const entry of Object.values(entriesMap)) {
        if (entry.kind === 'table') counts.tables++;
        else if (entry.kind === 'view' || entry.kind === 'matview') counts.views++;
        else if (entry.kind === 'function') counts.functions++;
        else if (entry.kind === 'enum') counts.enums++;
      }

      // Build embeddings if enableEmbeddings config is true
      const config = vscode.workspace.getConfiguration();
      const isEmbedEnabled = config.get<boolean>('postgresExplorer.dbIndex.enableEmbeddings', false);
      let embeddingsRef: string | undefined;
      let embeddingsMetaRef: string | undefined;

      if (isEmbedEnabled) {
        const embedCandidates: { ref: string; doc: string }[] = [];
        for (const [ref, entry] of Object.entries(entriesMap)) {
          if (entry.kind === 'table' || entry.kind === 'view' || entry.kind === 'matview') {
            const doc = buildObjectDoc(ref, entry);
            embedCandidates.push({ ref, doc });
          }
        }

        if (embedCandidates.length > 0) {
          try {
            let vectors: number[][] = [];
            let modelName = 'Xenova/all-MiniLM-L6-v2';
            let dim = 384;

            const provider = config.get<string>('postgresExplorer.aiProvider', 'vscode-lm');
            const isEmbedPro = isProFeatureEnabled(ProFeature.DbIndexEmbed);
            const hasProviderKeys = provider !== 'vscode-lm' && provider !== 'cursor' && provider !== 'opencode';

            if (isEmbedPro && hasProviderKeys) {
              // Use provider embeddings
              progress?.report({ message: 'Generating provider-based embeddings...' });
              const { generateEmbedding } = require('./embeddings');
              for (let i = 0; i < embedCandidates.length; i++) {
                this.checkCancelled(cancellationToken);
                progress?.report({ message: `Generating provider embeddings: ${i + 1}/${embedCandidates.length}` });
                const { vector, model } = await generateEmbedding(embedCandidates[i].doc, config);
                vectors.push(vector);
                modelName = model;
                dim = vector.length;
              }
            } else {
              // Use local embeddings (free)
              progress?.report({ message: 'Generating local embeddings...' });
              const { generateLocalEmbeddingsBatch } = require('./localEmbedder');
              vectors = await generateLocalEmbeddingsBatch(
                embedCandidates.map(c => c.doc),
                this.store.globalStorageUri,
                progress,
                cancellationToken
              );
              modelName = 'Xenova/all-MiniLM-L6-v2';
              dim = 384;
            }

            this.checkCancelled(cancellationToken);

            // Serialize and write embeddings
            const { serializeEmbeddings } = require('./embeddings');
            const binBuffer = serializeEmbeddings(vectors, dim);
            const embeddingsBinUri = vscode.Uri.joinPath(baseDir, 'embeddings.bin');
            await this.store.writeAtomic(embeddingsBinUri, binBuffer);

            // Write metadata
            const metaEntries: EmbeddingMetaEntry[] = embedCandidates.map((c, idx) => ({
              ref: c.ref,
              objectHash: entriesMap[c.ref]?.objectHash || '',
              model: modelName,
              dim
            }));
            const embeddingsMetaUri = vscode.Uri.joinPath(baseDir, 'embeddings-meta.json');
            await this.store.writeAtomic(embeddingsMetaUri, Buffer.from(JSON.stringify(metaEntries), 'utf-8'));

            embeddingsRef = 'embeddings.bin';
            embeddingsMetaRef = 'embeddings-meta.json';

          } catch (err: any) {
            warnings.push(`Generating embeddings failed: ${err.message || err}`);
          }
        }
      }

      // 11. Compile and save manifest
      const buildMs = Date.now() - startBuild;
      const manifest: IndexManifest = {
        formatVersion: 1,
        connectionId,
        database,
        indexedAt: new Date().toISOString(),
        buildMode,
        buildDepth: depth,
        schemaFingerprint,
        pgVersion,
        environment,
        scope,
        counts,
        shards,
        derived: {
          tokens: 'tokens.json',
          joinGraph: 'joingraph.json',
          values: 'values.json',
          embeddings: embeddingsRef,
          embeddingsMeta: embeddingsMetaRef,
        },
        stats: {
          buildMs,
          queriesRun,
          warnings,
        },
      };

      const manifestUri = vscode.Uri.joinPath(baseDir, 'manifest.json');
      await this.store.writeAtomic(manifestUri, Buffer.from(JSON.stringify(manifest), 'utf-8'));

      // 12. Run stale file cleanup GC
      await this.store.runGarbageCollection(baseDir, manifest);

      return manifest;
    } finally {
      // Release client back to the pool
      try {
        client.release();
      } catch {
        // ignore release errors
      }
    }
  }

  private addPosting(tokenIndex: TokenIndex, token: string, ref: string, weight: number): void {
    if (!tokenIndex.postings[token]) {
      tokenIndex.postings[token] = [];
    }
    const postings = tokenIndex.postings[token];
    const match = postings.find(p => p[0] === ref);
    if (match) {
      match[1] = Math.max(match[1], weight);
    } else {
      postings.push([ref, weight]);
    }
  }

  private checkCancelled(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }
}
