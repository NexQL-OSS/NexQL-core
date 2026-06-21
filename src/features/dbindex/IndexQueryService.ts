import * as vscode from 'vscode';
import { IndexStore } from './IndexStore';
import { IndexManifest, ObjectEntry, TokenIndex, JoinGraph, EmbeddingMetaEntry } from './types';
import { tokenize, scoreObject } from './lexical';
import { findShortestJoinPath } from './joinPath';
import { buildContextPack } from './contextPack';
import { cosineSimilarity, deserializeEmbedding } from './embeddings';
import { generateEmbedding } from './embeddings';

export interface RankedHit {
  ref: string;
  score: number;
  kind: string;
}

export interface RankedContext {
  packMarkdown: string;
  objects: Array<{ ref: string; score: number; detail: 'full' | 'columns' | 'skeleton' }>;
  joinHints: string[];
  tokensUsed: number;
  staleness: {
    indexedAt: string;
    fingerprintMatch: boolean;
  };
}

export class IndexQueryService {
  constructor(private readonly store: IndexStore) {}

  /**
   * High-level schema retrieval to ground chat inputs.
   * Returns null if no index exists for the connection/database.
   */
  public async retrieve(
    connectionId: string,
    database: string,
    question: string,
    budgetTokens: number,
    config: vscode.WorkspaceConfiguration
  ): Promise<RankedContext | null> {
    const baseDir = this.store.getBaseDir(connectionId, database);
    const manifest = await this.store.readManifest(baseDir);
    if (!manifest) {
      return null;
    }

    const tokensIndex = await this.store.readTokens(baseDir, manifest);
    const joinGraph = await this.store.readJoinGraph(baseDir, manifest);
    if (!tokensIndex || !joinGraph) {
      return null;
    }

    // 1. Perform lexical search
    const queryTokens = tokenize(question);
    const lexicalScores: Record<string, number> = {};

    // Collect all object refs from manifest/shards
    const allRefs: string[] = [];
    for (const shard of manifest.shards) {
      // Find refs mapped to this schema
      const shardUri = vscode.Uri.joinPath(baseDir, shard.file);
      try {
        const data = await vscode.workspace.fs.readFile(shardUri);
        const entries = JSON.parse(Buffer.from(data).toString('utf-8')) as Record<string, ObjectEntry>;
        allRefs.push(...Object.keys(entries));
      } catch {
        // ignore shard load errors during scoring
      }
    }

    for (const ref of allRefs) {
      const score = scoreObject(ref, queryTokens, tokensIndex, manifest.counts);
      if (score > 0) {
        lexicalScores[ref] = score;
      }
    }

    // Sort by lexical score descending
    const lexicalHits = Object.entries(lexicalScores)
      .map(([ref, score]) => ({ ref, score }))
      .sort((a, b) => b.score - a.score);

    let hits = lexicalHits.slice(0, 10);

    // 2. Premium: Semantic search if embeddings exist
    const isEmbedEnabled = config.get<boolean>('postgresExplorer.dbIndex.enableEmbeddings', false);
    if (isEmbedEnabled && manifest.derived.embeddings && manifest.derived.embeddingsMeta) {
      try {
        const embeddingsMetaUri = vscode.Uri.joinPath(baseDir, manifest.derived.embeddingsMeta);
        const embeddingsBinUri = vscode.Uri.joinPath(baseDir, manifest.derived.embeddings);

        const metaData = await vscode.workspace.fs.readFile(embeddingsMetaUri);
        const metaEntries = JSON.parse(Buffer.from(metaData).toString('utf-8')) as EmbeddingMetaEntry[];

        const binData = await vscode.workspace.fs.readFile(embeddingsBinUri);

        // Generate query embedding vector
        const { vector: queryVec } = await generateEmbedding(question, config);

        const semanticHits: { ref: string; score: number }[] = [];
        for (let i = 0; i < metaEntries.length; i++) {
          const meta = metaEntries[i];
          if (meta) {
            const docVec = deserializeEmbedding(binData, i, meta.dim);
            const sim = cosineSimilarity(queryVec, docVec);
            if (sim > 0) {
              semanticHits.push({ ref: meta.ref, score: sim });
            }
          }
        }

        // Merge using Reciprocal Rank Fusion (RRF)
        const lexicalRank = new Map(lexicalHits.map((h, idx) => [h.ref, idx]));
        const semanticRank = new Map(semanticHits.sort((a, b) => b.score - a.score).map((h, idx) => [h.ref, idx]));

        const rrfScores: { ref: string; score: number }[] = [];
        const mergedRefs = new Set([...lexicalRank.keys(), ...semanticRank.keys()]);

        for (const ref of mergedRefs) {
          const rL = lexicalRank.has(ref) ? lexicalRank.get(ref)! : 10000;
          const rS = semanticRank.has(ref) ? semanticRank.get(ref)! : 10000;
          const rrf = (1 / (60 + rL)) + (1 / (60 + rS));
          rrfScores.push({ ref, score: rrf });
        }

        hits = rrfScores.sort((a, b) => b.score - a.score).slice(0, 10);
      } catch {
        // Fall back to lexical hits on embedding failures
      }
    }

    const topK = hits.slice(0, 5);
    const topKRefs = topK.map(h => h.ref);

    // 3. Compute join paths and expand hits
    const finalHitsMap = new Map<string, { ref: string; score: number; detail: 'full' | 'columns' | 'skeleton' }>();
    for (const h of topK) {
      finalHitsMap.set(h.ref, { ref: h.ref, score: h.score, detail: 'full' });
    }

    const joinHints: string[] = [];

    // Pairwise BFS paths between top-k tables
    for (let i = 0; i < topKRefs.length; i++) {
      for (let j = i + 1; j < topKRefs.length; j++) {
        const tA = topKRefs[i];
        const tB = topKRefs[j];
        if (tA && tB) {
          const path = findShortestJoinPath(tA, tB, joinGraph);
          if (path && path.length > 0) {
            for (const edge of path) {
              // Add join hint details
              const colPairs = edge.cols.map(c => `${edge.from}.${c[0]} = ${edge.to}.${c[1]}`).join(' AND ');
              const hint = `${colPairs} (${edge.via})`;
              if (!joinHints.includes(hint)) {
                joinHints.push(hint);
              }

              // Add connecting intermediate tables to hits as skeleton
              if (!finalHitsMap.has(edge.from)) {
                finalHitsMap.set(edge.from, { ref: edge.from, score: 0.1, detail: 'skeleton' });
              }
              if (!finalHitsMap.has(edge.to)) {
                finalHitsMap.set(edge.to, { ref: edge.to, score: 0.1, detail: 'skeleton' });
              }
            }
          }
        }
      }
    }

    // 4. Token budget-aware detail degradation
    let hitsList = Array.from(finalHitsMap.values()).sort((a, b) => b.score - a.score);
    let estimatedTokens = this.estimateContextTokens(hitsList, manifest);

    // Degrade hits to columns then skeleton until it fits the budget
    while (estimatedTokens > budgetTokens && hitsList.some(h => h.detail !== 'skeleton')) {
      for (const hit of hitsList) {
        if (hit.detail === 'full') {
          hit.detail = 'columns';
          break;
        } else if (hit.detail === 'columns') {
          hit.detail = 'skeleton';
          break;
        }
      }
      estimatedTokens = this.estimateContextTokens(hitsList, manifest);
    }

    // If still over budget, slice hits off the tail
    while (estimatedTokens > budgetTokens && hitsList.length > 1) {
      hitsList.pop();
      estimatedTokens = this.estimateContextTokens(hitsList, manifest);
    }

    // 5. Check fingerprint drift (rely on AutoRefreshService callback cache)
    let fingerprintMatch = true;
    try {
      const { AutoRefreshService } = require('../../services/AutoRefreshService');
      const activeFp = AutoRefreshService.getFingerprint?.(connectionId, database);
      if (activeFp && activeFp !== manifest.schemaFingerprint) {
        fingerprintMatch = false;
      }
    } catch {
      // ignore
    }

    const packMarkdown = await buildContextPack(
      hitsList,
      this.store,
      baseDir,
      manifest,
      joinHints,
      !fingerprintMatch,
      question
    );

    return {
      packMarkdown,
      objects: hitsList,
      joinHints,
      tokensUsed: estimatedTokens,
      staleness: {
        indexedAt: manifest.indexedAt,
        fingerprintMatch,
      },
    };
  }

  /**
   * Search for objects by matching query token scores. Used by agent search_schema tools.
   */
  public async search(
    connectionId: string,
    database: string,
    query: string,
    limit: number = 10
  ): Promise<RankedHit[]> {
    const baseDir = this.store.getBaseDir(connectionId, database);
    const manifest = await this.store.readManifest(baseDir);
    if (!manifest) {
      return [];
    }

    const tokensIndex = await this.store.readTokens(baseDir, manifest);
    if (!tokensIndex) {
      return [];
    }

    const queryTokens = tokenize(query);
    const hits: RankedHit[] = [];

    // Enumerate shards and collect entries to score
    for (const shard of manifest.shards) {
      const shardUri = vscode.Uri.joinPath(baseDir, shard.file);
      try {
        const data = await vscode.workspace.fs.readFile(shardUri);
        const entries = JSON.parse(Buffer.from(data).toString('utf-8')) as Record<string, ObjectEntry>;
        for (const [ref, entry] of Object.entries(entries)) {
          const score = scoreObject(ref, queryTokens, tokensIndex, manifest.counts);
          if (score > 0) {
            hits.push({ ref, score, kind: entry.kind });
          }
        }
      } catch {
        // ignore
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Fast-path describe object utilizing cached index shards.
   */
  public async describe(connectionId: string, database: string, ref: string): Promise<ObjectEntry | null> {
    const baseDir = this.store.getBaseDir(connectionId, database);
    const manifest = await this.store.readManifest(baseDir);
    if (!manifest) {
      return null;
    }

    const parts = ref.split('.');
    const schema = parts[0] || 'public';
    const name = parts[1] || '';

    return await this.store.getObjectEntry(baseDir, manifest, schema, name);
  }

  private estimateContextTokens(
    hits: Array<{ ref: string; detail: 'full' | 'columns' | 'skeleton' }>,
    manifest: IndexManifest
  ): number {
    let tokens = 100; // base markdown structure wrapping overhead
    for (const hit of hits) {
      const shard = manifest.shards.find(s => s.schema === hit.ref.split('.')[0]);
      const approxObjectBytes = shard ? Math.round(shard.bytes / shard.objects) : 1000;

      if (hit.detail === 'full') {
        tokens += Math.round(approxObjectBytes / 4);
      } else if (hit.detail === 'columns') {
        tokens += Math.round(approxObjectBytes / 12);
      } else {
        tokens += 30; // skeleton table name + columns list token estimate
      }
    }
    return tokens;
  }
}
