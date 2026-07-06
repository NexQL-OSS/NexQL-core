import * as vscode from 'vscode';
import { IndexStore } from './IndexStore';
import { IndexManifest, ObjectEntry, TokenIndex, JoinGraph } from './types';
import { tokenize, scoreObject, candidateRefsFromPostings } from './lexical';
import { findShortestJoinPath } from './joinPath';
import { ProFeature, isProFeatureEnabled } from '../../services/featureGates';
import { buildContextPack } from './contextPack';
import { cosineSimilarity, deserializeEmbedding } from './embeddings';

export interface RankedHit {
  ref: string;
  /** Lexical TF-IDF score normally; RRF score (~0.016-0.033) when semantic fusion applied. */
  score: number;
  kind: string;
}

/** Embedder functions, injectable for tests; defaults lazy-require the real modules. */
export interface EmbedderDeps {
  generateLocalEmbedding(text: string, storageUri: vscode.Uri): Promise<number[]>;
  generateEmbedding(text: string, config: vscode.WorkspaceConfiguration): Promise<{ vector: number[]; model: string }>;
}

const RRF_K = 60;
const RRF_MISSING_RANK = 10000;

/**
 * Reciprocal Rank Fusion of two ranked lists (both sorted descending by score).
 * The union of both lists is ranked, so semantic-only refs survive fusion.
 */
export function fuseRrf(
  lexical: Array<{ ref: string; score: number }>,
  semantic: Array<{ ref: string; score: number }>,
  limit: number
): Array<{ ref: string; score: number }> {
  const lexicalRank = new Map(lexical.map((h, idx) => [h.ref, idx]));
  const semanticRank = new Map(semantic.map((h, idx) => [h.ref, idx]));

  const rrfScores: { ref: string; score: number }[] = [];
  const mergedRefs = new Set([...lexicalRank.keys(), ...semanticRank.keys()]);

  for (const ref of mergedRefs) {
    const rL = lexicalRank.has(ref) ? lexicalRank.get(ref)! : RRF_MISSING_RANK;
    const rS = semanticRank.has(ref) ? semanticRank.get(ref)! : RRF_MISSING_RANK;
    rrfScores.push({ ref, score: (1 / (RRF_K + rL)) + (1 / (RRF_K + rS)) });
  }

  return rrfScores.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Query embedding vectors keyed `${model}::${question}`. Module-level because
// callers construct a fresh IndexQueryService per call; helps agent turns that
// repeat similar queries across tool calls.
const queryVecCache = new Map<string, number[]>();
const QUERY_VEC_CACHE_MAX = 20;

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
  constructor(
    private readonly store: IndexStore,
    private readonly embedders?: Partial<EmbedderDeps>
  ) {}

  /**
   * Rank all embedded objects against the question by cosine similarity.
   * Returns null when semantic search is unavailable (config off, no
   * embeddings built, pro gate closed for provider-built indexes, or any
   * error) — caller keeps its lexical results.
   */
  private async computeSemanticHits(
    baseDir: vscode.Uri,
    manifest: IndexManifest,
    question: string,
    excludedRefs: Set<string>,
    config: vscode.WorkspaceConfiguration
  ): Promise<Array<{ ref: string; score: number }> | null> {
    if (!config.get<boolean>('postgresExplorer.dbIndex.enableEmbeddings', false)) {
      return null;
    }
    try {
      const emb = await this.store.readEmbeddings(baseDir, manifest);
      if (!emb || emb.meta.length === 0) {
        return null;
      }

      const model = emb.meta[0].model;
      const cacheKey = `${model}::${question}`;
      let queryVec = queryVecCache.get(cacheKey) ?? null;
      if (queryVec) {
        // Refresh recency
        queryVecCache.delete(cacheKey);
        queryVecCache.set(cacheKey, queryVec);
      } else {
        // The query vector must come from the same model the index was built
        // with, or dimensions won't match. Local model needs no pro gate.
        if (model === 'Xenova/all-MiniLM-L6-v2') {
          const generateLocal = this.embedders?.generateLocalEmbedding
            ?? require('./localEmbedder').generateLocalEmbedding;
          queryVec = await generateLocal(question, this.store.globalStorageUri);
        } else if (isProFeatureEnabled(ProFeature.DbIndexEmbed)) {
          const generate = this.embedders?.generateEmbedding
            ?? require('./embeddings').generateEmbedding;
          const res = await generate(question, config);
          queryVec = res.vector;
        }
        if (!queryVec) {
          return null;
        }
        if (queryVecCache.size >= QUERY_VEC_CACHE_MAX) {
          const oldest = queryVecCache.keys().next().value;
          if (oldest !== undefined) {
            queryVecCache.delete(oldest);
          }
        }
        queryVecCache.set(cacheKey, queryVec);
      }

      const semanticHits: { ref: string; score: number }[] = [];
      for (let i = 0; i < emb.meta.length; i++) {
        const meta = emb.meta[i];
        if (!meta || excludedRefs.has(meta.ref)) {
          continue;
        }
        const docVec = deserializeEmbedding(emb.bin, i, meta.dim);
        const sim = cosineSimilarity(queryVec, docVec);
        if (sim > 0) {
          semanticHits.push({ ref: meta.ref, score: sim });
        }
      }
      return semanticHits.sort((a, b) => b.score - a.score);
    } catch (err: any) {
      console.warn('[IndexQueryService] Semantic search failed, falling back to lexical search.', err);
      return null;
    }
  }

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
    console.log(`[IndexQueryService] retrieve: Starting retrieval for question="${question}" in db="${database}"`);
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

    const overrides = await this.store.readOverrides(baseDir);
    const excludedRefs = new Set<string>();
    if (overrides?.objects) {
      for (const [ref, obj] of Object.entries(overrides.objects)) {
        if (obj.excluded) {
          excludedRefs.add(ref);
        }
      }
    }

    // Get candidate refs from postings (direct and synonyms)
    const candidates = candidateRefsFromPostings(queryTokens, tokensIndex);
    console.log(`[IndexQueryService] retrieve: Found ${candidates.length} lexical candidates. queryTokens:`, queryTokens);

    for (const ref of candidates) {
      if (excludedRefs.has(ref)) {
        continue;
      }
      const score = scoreObject(ref, queryTokens, tokensIndex, manifest.counts);
      if (score > 0) {
        lexicalScores[ref] = score;
      }
    }

    // Read values.json if it exists and apply value token hits boost
    const valueIndex = await this.store.readValues(baseDir, manifest);
    if (valueIndex) {
      for (const token of queryTokens) {
        const valHits = valueIndex[token];
        if (valHits) {
          for (const hit of valHits) {
            if (excludedRefs.has(hit.ref)) {
              continue;
            }
            if (overrides?.objects?.[hit.ref]?.columns?.[hit.col]?.pii) {
              continue;
            }
            lexicalScores[hit.ref] = (lexicalScores[hit.ref] || 0) + 2.0;
          }
        }
      }
    }

    // Sort by lexical score descending
    const lexicalHits = Object.entries(lexicalScores)
      .map(([ref, score]) => ({ ref, score }))
      .sort((a, b) => b.score - a.score);
    console.log(`[IndexQueryService] retrieve: Top lexical hits:`, lexicalHits.slice(0, 5));

    let hits = lexicalHits.slice(0, 10);

    // 2. Premium: Semantic search if embeddings exist
    const semanticHits = await this.computeSemanticHits(baseDir, manifest, question, excludedRefs, config);
    if (semanticHits) {
      hits = fuseRrf(lexicalHits, semanticHits, 10);
      console.log(`[IndexQueryService] retrieve: RRF merged hits:`, hits.slice(0, 5));
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
    console.log(`[IndexQueryService] retrieve: Budget tokens = ${budgetTokens}, Estimated tokens after degradation = ${estimatedTokens}. Final selected objects:`, hitsList.map(h => `${h.ref} (${h.detail})`));

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
   * Pass `opts.semantic` to fuse embeddings-based similarity via RRF when the
   * index has embeddings (silently stays lexical otherwise). Keystroke-driven
   * callers (@-mention autocomplete) must NOT pass it — query embedding can
   * hit the network or load a local model.
   */
  public async search(
    connectionId: string,
    database: string,
    query: string,
    limit: number = 10,
    opts?: { semantic?: boolean }
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
    const candidates = candidateRefsFromPostings(queryTokens, tokensIndex);
    const scoresMap: Record<string, number> = {};

    const overrides = await this.store.readOverrides(baseDir);
    const excludedRefs = new Set<string>();
    if (overrides?.objects) {
      for (const [ref, obj] of Object.entries(overrides.objects)) {
        if (obj.excluded) {
          excludedRefs.add(ref);
        }
      }
    }

    for (const ref of candidates) {
      if (excludedRefs.has(ref)) {
        continue;
      }
      const score = scoreObject(ref, queryTokens, tokensIndex, manifest.counts);
      if (score > 0) {
        scoresMap[ref] = score;
      }
    }

    const valueIndex = await this.store.readValues(baseDir, manifest);
    if (valueIndex) {
      for (const token of queryTokens) {
        const valHits = valueIndex[token];
        if (valHits) {
          for (const hit of valHits) {
            if (excludedRefs.has(hit.ref)) {
              continue;
            }
            if (overrides?.objects?.[hit.ref]?.columns?.[hit.col]?.pii) {
              continue;
            }
            scoresMap[hit.ref] = (scoresMap[hit.ref] || 0) + 2.0;
          }
        }
      }
    }

    // Full sorted list (no pre-slice) so RRF ranks match retrieve() semantics.
    let sortedCandidates = Object.entries(scoresMap)
      .map(([ref, score]) => ({ ref, score }))
      .sort((a, b) => b.score - a.score);

    if (opts?.semantic) {
      const config = vscode.workspace.getConfiguration();
      const semanticHits = await this.computeSemanticHits(baseDir, manifest, query, excludedRefs, config);
      if (semanticHits) {
        sortedCandidates = fuseRrf(sortedCandidates, semanticHits, limit);
      }
    }
    sortedCandidates = sortedCandidates.slice(0, limit);

    const hits: RankedHit[] = [];
    for (const item of sortedCandidates) {
      const parts = item.ref.split('.');
      const schema = parts[0] || 'public';
      const name = parts[1] || '';
      const entry = await this.store.getObjectEntry(baseDir, manifest, schema, name);
      hits.push({
        ref: item.ref,
        score: item.score,
        kind: entry ? entry.kind : 'table'
      });
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

    const entry = await this.store.getObjectEntry(baseDir, manifest, schema, name);
    if (!entry || entry.excluded) {
      return null;
    }
    return entry;
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
