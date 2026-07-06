import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { IndexQueryService, fuseRrf } from '../../features/dbindex/IndexQueryService';
import { IndexStore } from '../../features/dbindex/IndexStore';
import { serializeEmbeddings } from '../../features/dbindex/embeddings';
import { ToolExecutor } from '../../providers/chat/tools/ToolExecutor';
import * as featureGates from '../../services/featureGates';

const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

function createManifest(overrides: any = {}) {
  return {
    formatVersion: 1,
    connectionId: 'conn-1',
    database: 'appdb',
    indexedAt: '2026-07-04T00:00:00.000Z',
    buildMode: 'auto',
    buildDepth: 'structure',
    schemaFingerprint: '1|2|3|4|5',
    pgVersion: '16.0',
    environment: 'development',
    scope: { includedSchemas: ['public'], excludedObjects: [], piiExcludedColumns: [] },
    counts: { tables: 10, views: 0, functions: 0, enums: 0 },
    shards: [],
    derived: { tokens: 'tokens.json', joinGraph: 'joingraph.json', embeddings: 'embeddings.bin', embeddingsMeta: 'embeddings-meta.json' },
    stats: { buildMs: 1, queriesRun: 1, warnings: [] },
    ...overrides,
  } as any;
}

// Postings keyed by stemmed tokens: 'order' outranks 'customer' lexically.
function createTokens() {
  return {
    version: 1,
    df: { order: 1, customer: 1 },
    postings: {
      order: [['public.orders', 5]],
      customer: [['public.customers', 3]],
    },
    synonyms: {},
  } as any;
}

function createEmbeddings(opts: { model?: string; refs?: string[]; vectors?: number[][]; dim?: number } = {}) {
  const refs = opts.refs ?? ['public.orders', 'public.customers', 'public.payments'];
  const dim = opts.dim ?? 2;
  const vectors = opts.vectors ?? [
    [0, 1],       // orders — orthogonal to query [1,0], sim 0 → dropped
    [1, 0],       // customers — sim 1
    [0.5, 0.866], // payments — sim 0.5, semantic-only (no lexical tokens)
  ];
  return {
    meta: refs.map(ref => ({ ref, objectHash: 'h', model: opts.model ?? LOCAL_MODEL, dim })),
    bin: serializeEmbeddings(vectors, dim),
  };
}

function createStore(opts: { manifest?: any; tokens?: any; embeddings?: any } = {}) {
  return {
    globalStorageUri: { fsPath: '/tmp/storage' } as any,
    getBaseDir: sinon.stub().returns({ toString: () => 'file:///tmp/dbindex/conn/db' } as any),
    readManifest: sinon.stub().resolves(opts.manifest ?? createManifest()),
    readTokens: sinon.stub().resolves(opts.tokens ?? createTokens()),
    readOverrides: sinon.stub().resolves(null),
    readValues: sinon.stub().resolves(null),
    readEmbeddings: sinon.stub().resolves(opts.embeddings ?? null),
    getObjectEntry: sinon.stub().resolves(null),
  } as any;
}

describe('fuseRrf', () => {
  it('fuses by reciprocal rank with the 10000 sentinel and keeps semantic-only refs', () => {
    const lexical = [{ ref: 'a', score: 5 }, { ref: 'b', score: 3 }];
    const semantic = [{ ref: 'b', score: 1 }, { ref: 'c', score: 0.5 }];

    const fused = fuseRrf(lexical, semantic, 10);

    const scores = new Map(fused.map(h => [h.ref, h.score]));
    expect(scores.get('b')).to.be.closeTo(1 / 61 + 1 / 60, 1e-9);
    expect(scores.get('a')).to.be.closeTo(1 / 60 + 1 / 10060, 1e-9);
    expect(scores.get('c')).to.be.closeTo(1 / 10060 + 1 / 61, 1e-9);
    expect(fused.map(h => h.ref)).to.deep.equal(['b', 'a', 'c']);
  });

  it('respects the limit', () => {
    const lexical = [{ ref: 'a', score: 2 }, { ref: 'b', score: 1 }];
    expect(fuseRrf(lexical, [], 1)).to.have.length(1);
  });
});

describe('IndexQueryService.search', function () {
  this.timeout(10000);

  let sandbox: sinon.SinonSandbox;
  let gateStub: sinon.SinonStub;
  let embedEnabled: boolean;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    embedEnabled = true;
    gateStub = sandbox.stub(featureGates, 'isProFeatureEnabled').returns(true);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === 'postgresExplorer.dbIndex.enableEmbeddings') {
          return embedEnabled as any;
        }
        return defaultValue as T;
      },
    } as any);
  });

  afterEach(() => {
    sandbox.restore();
  });

  function createEmbedders(queryVec: number[] = [1, 0]) {
    return {
      generateLocalEmbedding: sinon.stub().resolves(queryVec),
      generateEmbedding: sinon.stub().resolves({ vector: queryVec, model: 'text-embedding-3-small' }),
    };
  }

  it('stays lexical by default and never touches embeddings', async () => {
    const store = createStore({ embeddings: createEmbeddings() });
    const embedders = createEmbedders();
    const service = new IndexQueryService(store, embedders);

    const hits = await service.search('conn-1', 'appdb', 'order customer', 10);

    expect(hits.map(h => h.ref)).to.deep.equal(['public.orders', 'public.customers']);
    expect(store.readEmbeddings.called).to.be.false;
    expect(embedders.generateLocalEmbedding.called).to.be.false;
    expect(embedders.generateEmbedding.called).to.be.false;
  });

  it('fuses semantic hits via RRF and surfaces semantic-only refs with resolved kind', async () => {
    const store = createStore({ embeddings: createEmbeddings() });
    store.getObjectEntry.callsFake(async (_b: any, _m: any, _schema: string, name: string) =>
      name === 'payments' ? { kind: 'view' } : { kind: 'table' }
    );
    const embedders = createEmbedders([1, 0]);
    const service = new IndexQueryService(store, embedders);

    const hits = await service.search('conn-1', 'appdb', 'order customer', 10, { semantic: true });

    // Lexical ranks: orders=0, customers=1. Semantic ranks: customers=0, payments=1.
    expect(hits.map(h => h.ref)).to.deep.equal(['public.customers', 'public.orders', 'public.payments']);
    const payments = hits.find(h => h.ref === 'public.payments')!;
    expect(payments.kind).to.equal('view');
    expect(embedders.generateLocalEmbedding.calledOnce).to.be.true;
  });

  it('stays lexical when the embeddings setting is disabled', async () => {
    embedEnabled = false;
    const store = createStore({ embeddings: createEmbeddings() });
    const embedders = createEmbedders();
    const service = new IndexQueryService(store, embedders);

    const hits = await service.search('conn-1', 'appdb', 'setting disabled order', 10, { semantic: true });

    expect(store.readEmbeddings.called).to.be.false;
    expect(hits.map(h => h.ref)).to.deep.equal(['public.orders']);
  });

  it('stays lexical when the index has no embeddings', async () => {
    const store = createStore({ embeddings: null });
    const embedders = createEmbedders();
    const service = new IndexQueryService(store, embedders);

    const hits = await service.search('conn-1', 'appdb', 'missing embeddings order', 10, { semantic: true });

    expect(embedders.generateLocalEmbedding.called).to.be.false;
    expect(hits.map(h => h.ref)).to.deep.equal(['public.orders']);
  });

  it('stays lexical for provider-built indexes when the pro gate is closed', async () => {
    gateStub.returns(false);
    const store = createStore({ embeddings: createEmbeddings({ model: 'text-embedding-3-small' }) });
    const embedders = createEmbedders();
    const service = new IndexQueryService(store, embedders);

    const hits = await service.search('conn-1', 'appdb', 'gated provider order', 10, { semantic: true });

    expect(embedders.generateEmbedding.called).to.be.false;
    expect(hits.map(h => h.ref)).to.deep.equal(['public.orders']);
  });

  it('does not consult the pro gate for local-model indexes', async () => {
    const store = createStore({ embeddings: createEmbeddings() });
    const embedders = createEmbedders();
    const service = new IndexQueryService(store, embedders);

    await service.search('conn-1', 'appdb', 'local model no gate', 10, { semantic: true });

    expect(embedders.generateLocalEmbedding.calledOnce).to.be.true;
    expect(gateStub.called).to.be.false;
  });

  it('survives a dimension mismatch without throwing', async () => {
    const store = createStore({ embeddings: createEmbeddings({ dim: 2 }) });
    const embedders = createEmbedders([1, 0, 0]); // 3-dim query vs 2-dim docs → sims 0
    const service = new IndexQueryService(store, embedders);

    const hits = await service.search('conn-1', 'appdb', 'dim mismatch order customer', 10, { semantic: true });

    // Semantic list empty but fusion still ranks lexical hits.
    expect(hits.map(h => h.ref)).to.deep.equal(['public.orders', 'public.customers']);
  });

  it('falls back to lexical silently when the embedder throws', async () => {
    const store = createStore({ embeddings: createEmbeddings() });
    const embedders = {
      generateLocalEmbedding: sinon.stub().rejects(new Error('model load failed')),
      generateEmbedding: sinon.stub().resolves({ vector: [1, 0], model: 'x' }),
    };
    const service = new IndexQueryService(store, embedders);

    const hits = await service.search('conn-1', 'appdb', 'embedder throws order', 10, { semantic: true });

    expect(hits.map(h => h.ref)).to.deep.equal(['public.orders']);
  });

  it('caches the query vector across service instances for the same model and query', async () => {
    const store = createStore({ embeddings: createEmbeddings() });
    const embedders = createEmbedders();

    await new IndexQueryService(store, embedders).search('conn-1', 'appdb', 'cached vector order', 10, { semantic: true });
    await new IndexQueryService(store, embedders).search('conn-1', 'appdb', 'cached vector order', 10, { semantic: true });

    expect(embedders.generateLocalEmbedding.calledOnce).to.be.true;
  });
});

describe('IndexStore.readEmbeddings', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function stubFs() {
    const meta = [{ ref: 'public.orders', objectHash: 'h', model: LOCAL_MODEL, dim: 2 }];
    const readFile = sandbox.stub(vscode.workspace.fs, 'readFile');
    readFile.callsFake(async (uri: any) => {
      const path = String(uri.fsPath ?? uri);
      if (path.endsWith('embeddings-meta.json')) {
        return new Uint8Array(Buffer.from(JSON.stringify(meta), 'utf-8'));
      }
      if (path.endsWith('embeddings.bin')) {
        return serializeEmbeddings([[1, 0]], 2);
      }
      throw new Error(`unexpected read: ${path}`);
    });
    return readFile;
  }

  it('reads, caches per manifest build, and misses on a new indexedAt', async () => {
    const readFile = stubFs();
    const store = new IndexStore({ fsPath: '/tmp/storage', toString: () => 'file:///tmp/storage' } as any);
    const baseDir = store.getBaseDir('conn-1', 'appdb');
    const manifest = createManifest();

    const first = await store.readEmbeddings(baseDir, manifest);
    const second = await store.readEmbeddings(baseDir, manifest);

    expect(first).to.not.be.null;
    expect(first!.meta[0].ref).to.equal('public.orders');
    expect(second).to.not.be.null;
    expect(readFile.callCount).to.equal(2); // meta + bin, once total

    const rebuilt = createManifest({ indexedAt: '2026-07-05T00:00:00.000Z' });
    await store.readEmbeddings(baseDir, rebuilt);
    expect(readFile.callCount).to.equal(4); // re-read after rebuild
  });

  it('returns null when the manifest has no embeddings refs', async () => {
    const store = new IndexStore({ fsPath: '/tmp/storage', toString: () => 'file:///tmp/storage' } as any);
    const baseDir = store.getBaseDir('conn-1', 'appdb');
    const manifest = createManifest({ derived: { tokens: 'tokens.json', joinGraph: 'joingraph.json' } });

    expect(await store.readEmbeddings(baseDir, manifest)).to.be.null;
  });

  it('returns null on read errors', async () => {
    sandbox.stub(vscode.workspace.fs, 'readFile').rejects(new Error('ENOENT'));
    const store = new IndexStore({ fsPath: '/tmp/storage', toString: () => 'file:///tmp/storage' } as any);
    const baseDir = store.getBaseDir('conn-1', 'appdb');

    expect(await store.readEmbeddings(baseDir, createManifest())).to.be.null;
  });
});

describe('ToolExecutor search_schema', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('requests semantic fusion from the index search', async () => {
    const searchStub = sandbox.stub(IndexQueryService.prototype, 'search').resolves([
      { ref: 'public.orders', score: 1, kind: 'table' },
    ]);
    const executor = new ToolExecutor(
      { globalStorageUri: { fsPath: '/tmp/storage', toString: () => 'file:///tmp/storage' } } as any,
      'conn-1',
      'appdb'
    );

    const result = await executor.executeTool('search_schema', { query: 'customer payments' });

    expect(searchStub.calledOnce).to.be.true;
    expect(searchStub.firstCall.args).to.deep.equal(['conn-1', 'appdb', 'customer payments', 10, { semantic: true }]);
    expect(JSON.parse(result)[0].ref).to.equal('public.orders');
  });
});
