import { expect } from 'chai';
import * as sinon from 'sinon';

import * as materializedViews from '../../commands/materializedViews';
import { MaterializedViewSQL } from '../../commands/sql/materializedViews';
import * as helper from '../../commands/helper';
import { QueryBuilder } from '../../commands/helper';

function createBuilderStub(sandbox: sinon.SinonSandbox) {
  const builder: any = {};
  builder.addMarkdown = sandbox.stub().returns(builder);
  builder.addSql = sandbox.stub().returns(builder);
  builder.show = sandbox.stub().resolves();
  sandbox.stub(helper as any, 'NotebookBuilder').callsFake(function () {
    return builder;
  });
  return builder;
}

function createDbConnection(overrides?: Partial<{ metadata: any; queryStub: sinon.SinonStub; release: sinon.SinonStub }>) {
  const queryStub = overrides?.queryStub ?? sinon.stub();
  const release = overrides?.release ?? sinon.stub();
  return {
    client: { query: queryStub },
    metadata: overrides?.metadata ?? {
      connectionId: 'conn-1',
      databaseName: 'db1',
      name: 'Local DB',
      host: 'localhost',
      port: 5432,
      username: 'postgres'
    },
    release
  };
}

async function assertSingleNotebookCommand(
  sandbox: sinon.SinonSandbox,
  command: (item: any, context: any) => Promise<void>,
  item: any,
  expectedSql: string,
  expectedMarkdownFragment: string
) {
  const builder = createBuilderStub(sandbox);
  const dbConnection = createDbConnection();
  const getDbConnection = sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);

  await command(item, {} as any);

  expect(getDbConnection.calledOnce).to.be.true;
  expect(getDbConnection.calledWithExactly(item)).to.be.true;
  expect(builder.addMarkdown.called).to.be.true;
  expect(builder.addMarkdown.firstCall.args[0]).to.include(expectedMarkdownFragment);
  expect(builder.addSql.calledOnce).to.be.true;
  expect(builder.addSql.calledWithExactly(expectedSql)).to.be.true;
  expect(builder.show.calledOnce).to.be.true;
  expect(dbConnection.release.calledOnce).to.be.true;
}

describe('MaterializedViewSQL', () => {
  it('builds the materialized view template variants', () => {
    expect(MaterializedViewSQL.select('public', 'sales_mv')).to.equal(`SELECT *
FROM public.sales_mv
LIMIT 100;`);
    expect(MaterializedViewSQL.refresh('public', 'sales_mv')).to.include('REFRESH MATERIALIZED VIEW public.sales_mv;');
    expect(MaterializedViewSQL.create('public', 'sales_mv')).to.include('CREATE MATERIALIZED VIEW public.sales_mv AS');
    expect(MaterializedViewSQL.drop('public', 'sales_mv')).to.equal(`DROP MATERIALIZED VIEW public.sales_mv;

-- Use CASCADE to also drop dependent objects
-- DROP MATERIALIZED VIEW public.sales_mv CASCADE;`);
    expect(MaterializedViewSQL.analyze('public', 'sales_mv')).to.equal('ANALYZE public.sales_mv;');
    expect(MaterializedViewSQL.createIndex('public', 'sales_mv')).to.equal(`CREATE UNIQUE INDEX sales_mv_unique_idx
    ON public.sales_mv (id);`);
  });
});

describe('materialized view commands', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('refreshes a materialized view notebook', async () => {
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;
    await assertSingleNotebookCommand(
      sandbox,
      materializedViews.cmdRefreshMatView,
      item,
      MaterializedViewSQL.refresh('public', 'sales_mv'),
      'Refresh Materialized View: `public.sales_mv`'
    );
  });

  it('creates a materialized view data notebook', async () => {
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;
    await assertSingleNotebookCommand(
      sandbox,
      materializedViews.cmdViewMatViewData,
      item,
      MaterializedViewSQL.select('public', 'sales_mv'),
      'View Data: `public.sales_mv`'
    );
  });

  it('creates a drop notebook for a materialized view', async () => {
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;
    await assertSingleNotebookCommand(
      sandbox,
      materializedViews.cmdDropMatView,
      item,
      MaterializedViewSQL.drop('public', 'sales_mv'),
      'Drop Materialized View: `public.sales_mv`'
    );
  });

  it('creates a create notebook for a materialized view', async () => {
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;
    await assertSingleNotebookCommand(
      sandbox,
      materializedViews.cmdCreateMaterializedView,
      item,
      MaterializedViewSQL.create('public', 'new_matview'),
      'Create New Materialized View in Schema: `public`'
    );
  });

  it('builds the materialized view operations notebook', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    const getDbConnection = sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;

    await materializedViews.cmdMatViewOperations(item, {} as any);

    expect(getDbConnection.calledOnceWithExactly(item)).to.be.true;
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Materialized View Operations: `public.sales_mv`');
    expect(builder.addSql.callCount).to.equal(5);
    expect(builder.addSql.getCall(0).args[0]).to.equal(MaterializedViewSQL.select('public', 'sales_mv'));
    expect(builder.addSql.getCall(1).args[0]).to.equal(MaterializedViewSQL.analyze('public', 'sales_mv'));
    expect(builder.addSql.getCall(2).args[0]).to.equal(MaterializedViewSQL.refresh('public', 'sales_mv'));
    expect(builder.addSql.getCall(3).args[0]).to.equal(MaterializedViewSQL.createIndex('public', 'sales_mv'));
    expect(builder.addSql.getCall(4).args[0]).to.equal(MaterializedViewSQL.drop('public', 'sales_mv'));
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('creates an edit notebook from the current definition', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub().resolves({ rows: [{ definition: 'SELECT id, total FROM source_sales WHERE active = true;' }] });
    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;

    await materializedViews.cmdEditMatView(item, {} as any);

    expect(queryStub.calledOnceWithExactly(QueryBuilder.matViewDefinition('public', 'sales_mv'))).to.be.true;
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Edit Materialized View: `public.sales_mv`');
    expect(builder.addSql.calledOnce).to.be.true;
    expect(builder.addSql.firstCall.args[0]).to.include('DROP MATERIALIZED VIEW IF EXISTS public.sales_mv;');
    expect(builder.addSql.firstCall.args[0]).to.include('CREATE MATERIALIZED VIEW public.sales_mv AS');
    expect(builder.addSql.firstCall.args[0]).to.include('SELECT id, total FROM source_sales WHERE active = true');
    expect(builder.addSql.firstCall.args[0]).to.include('WITH DATA;');
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('reports a missing materialized view definition', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub().resolves({ rows: [{}] });
    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const handleCommandError = sandbox.stub(helper.ErrorHandlers, 'handleCommandError').resolves();
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;

    await materializedViews.cmdEditMatView(item, {} as any);

    expect(handleCommandError.calledOnce).to.be.true;
    expect(handleCommandError.firstCall.args[1]).to.equal('create materialized view edit notebook');
    expect(builder.show.called).to.be.false;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('builds the materialized view properties notebook', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub();
    queryStub.onCall(0).resolves({
      rows: [
        {
          schema_name: 'public',
          matview_name: 'sales_mv',
          owner: 'postgres',
          ispopulated: true,
          total_size: '1 MB',
          table_size: '768 kB',
          indexes_size: '256 kB',
          row_estimate: 1234,
          comment: "Owner's summary"
        }
      ]
    });
    queryStub.onCall(1).resolves({
      rows: [
        {
          ordinal_position: 1,
          column_name: 'id',
          data_type: 'integer',
          character_maximum_length: null,
          numeric_precision: null,
          numeric_scale: null,
          is_nullable: 'NO',
          default_value: null,
          description: 'Primary key'
        },
        {
          ordinal_position: 2,
          column_name: 'total',
          data_type: 'numeric',
          character_maximum_length: null,
          numeric_precision: 12,
          numeric_scale: 2,
          is_nullable: 'YES',
          default_value: '0.0',
          description: 'Aggregated total'
        }
      ]
    });
    queryStub.onCall(2).resolves({
      rows: [
        {
          index_name: 'sales_mv_unique_idx',
          is_primary: true,
          is_unique: true,
          columns: 'id',
          index_size: '64 kB',
          definition: 'CREATE UNIQUE INDEX sales_mv_unique_idx ON public.sales_mv (id);'
        },
        {
          index_name: 'sales_mv_total_idx',
          is_primary: false,
          is_unique: false,
          columns: 'total',
          index_size: '32 kB',
          definition: 'CREATE INDEX sales_mv_total_idx ON public.sales_mv (total);'
        }
      ]
    });
    queryStub.onCall(3).resolves({
      rows: [
        { kind: 'r', schema: 'public', name: 'source_sales' }
      ]
    });
    queryStub.onCall(4).resolves({
      rows: [
        { kind: 'v', schema: 'public', name: 'sales_summary' }
      ]
    });
    queryStub.onCall(5).resolves({
      rows: [
        { live_tuples: 1234, dead_tuples: 7 }
      ]
    });
    queryStub.onCall(6).resolves({ rows: [{ definition: 'SELECT id, total FROM source_sales WHERE active = true;' }] });

    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;

    await materializedViews.cmdViewMatViewProperties(item, {} as any);

    expect(queryStub.getCall(0).args[0]).to.equal(QueryBuilder.matViewInfo('public', 'sales_mv'));
    expect(queryStub.getCall(1).args[0]).to.equal(QueryBuilder.tableColumns('public', 'sales_mv'));
    expect(queryStub.getCall(2).args[0]).to.equal(QueryBuilder.tableIndexes('public', 'sales_mv'));
    expect(queryStub.getCall(3).args[0]).to.equal(QueryBuilder.objectDependencies('public', 'sales_mv'));
    expect(queryStub.getCall(4).args[0]).to.equal(QueryBuilder.objectReferences('public', 'sales_mv'));
    expect(queryStub.getCall(5).args[0]).to.equal(QueryBuilder.matViewStats('public', 'sales_mv'));
    expect(queryStub.getCall(6).args[0]).to.equal(QueryBuilder.matViewDefinition('public', 'sales_mv'));
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Materialized View Properties: `public.sales_mv`');
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Columns (2)');
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Indexes (2)');
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Referenced Objects (1)');
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Dependent Objects (1)');
    expect(builder.addSql.callCount).to.equal(5);
    expect(builder.addSql.getCall(0).args[0]).to.include('DROP MATERIALIZED VIEW IF EXISTS public.sales_mv;');
    expect(builder.addSql.getCall(0).args[0]).to.include('CREATE MATERIALIZED VIEW public.sales_mv AS');
    expect(builder.addSql.getCall(0).args[0]).to.include("COMMENT ON MATERIALIZED VIEW public.sales_mv IS 'Owner''s summary';");
    expect(builder.addSql.getCall(0).args[0]).to.include('CREATE UNIQUE INDEX sales_mv_unique_idx ON public.sales_mv (id);');
    expect(builder.addSql.getCall(1).args[0]).to.equal(MaterializedViewSQL.refresh('public', 'sales_mv'));
    expect(builder.addSql.getCall(2).args[0]).to.equal(MaterializedViewSQL.select('public', 'sales_mv'));
    expect(builder.addSql.getCall(3).args[0]).to.include('SELECT');
    expect(builder.addSql.getCall(4).args[0]).to.equal(MaterializedViewSQL.drop('public', 'sales_mv'));
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('reports missing materialized view metadata', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub();
    queryStub.onCall(0).resolves({ rows: [] });
    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const handleCommandError = sandbox.stub(helper.ErrorHandlers, 'handleCommandError').resolves();
    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'sales_mv' } as any;

    await materializedViews.cmdViewMatViewProperties(item, {} as any);

    expect(handleCommandError.calledOnce).to.be.true;
    expect(handleCommandError.firstCall.args[1]).to.equal('show materialized view properties');
    expect(builder.show.called).to.be.false;
    expect(dbConnection.release.calledOnce).to.be.true;
  });
});