import { expect } from 'chai';
import * as sinon from 'sinon';

import * as foreignTables from '../../commands/foreignTables';
import { ForeignTableSQL } from '../../commands/sql/foreignTables';
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

describe('ForeignTableSQL', () => {
  it('builds the foreign table template variants', () => {
    expect(ForeignTableSQL.queryData('public', 'remote_orders')).to.equal(`-- Query data
SELECT *
FROM public.remote_orders
LIMIT 100;`);

    expect(ForeignTableSQL.edit('public', 'remote_orders')).to.equal(`-- Edit table (requires dropping and recreating)
DROP FOREIGN TABLE IF EXISTS public.remote_orders;

CREATE FOREIGN TABLE public.remote_orders (
    -- Define columns here
    column_name data_type
) SERVER server_name
OPTIONS (
    schema_name 'remote_schema',
    table_name 'remote_table'
);`);

    expect(ForeignTableSQL.drop('public', 'remote_orders')).to.equal(`-- Drop table
DROP FOREIGN TABLE IF EXISTS public.remote_orders;`);

    expect(ForeignTableSQL.create.basic('public')).to.include('CREATE FOREIGN TABLE public.foreign_table_name');
    expect(ForeignTableSQL.create.postgresRemote('public')).to.include('CREATE FOREIGN TABLE public.remote_table');
    expect(ForeignTableSQL.create.fileBased('public')).to.include('CREATE FOREIGN TABLE public.csv_data');
    expect(ForeignTableSQL.queryWithJoin('public')).to.include('JOIN public.foreign_table_name ft ON lt.id = ft.id;');
    expect(ForeignTableSQL.manageForeignServer()).to.include('DROP SERVER foreign_server_name CASCADE;');
  });
});

describe('foreign table commands', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('refreshes the selected tree item', async () => {
    const refresh = sandbox.stub();

    await foreignTables.cmdRefreshForeignTable({ label: 'remote_orders' } as any, {} as any, { refresh } as any);

    expect(refresh.calledOnce).to.be.true;
  });

  it('creates a preview notebook for a foreign table', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    const getDbConnection = sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);

    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'remote_orders' } as any;

    await foreignTables.cmdViewForeignTableData(item, {} as any);

    expect(getDbConnection.calledOnceWithExactly(item)).to.be.true;
    expect(builder.addMarkdown.calledTwice).to.be.true;
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Query Foreign Table Data: `public.remote_orders`');
    expect(builder.addSql.calledOnceWithExactly(ForeignTableSQL.queryData('public', 'remote_orders'))).to.be.true;
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('builds the foreign table operations notebook from metadata', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub();
    queryStub.resolves({
      rows: [
        {
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null,
          server_name: 'remote_server',
          options: ["schema_name 'remote'", "table_name 'orders'"]
        },
        {
          column_name: 'customer_name',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
          server_name: 'remote_server',
          options: ["schema_name 'remote'", "table_name 'orders'"]
        }
      ]
    });
    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);

    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'remote_orders' } as any;

    await foreignTables.cmdForeignTableOperations(item, {} as any);

    expect(queryStub.calledOnceWithExactly(QueryBuilder.foreignTableInfo('public', 'remote_orders'))).to.be.true;
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Foreign Table Operations');
    expect(builder.addSql.callCount).to.equal(4);
    expect(builder.addSql.firstCall.args[0]).to.include('CREATE FOREIGN TABLE public.remote_orders');
    expect(builder.addSql.firstCall.args[0]).to.include('SERVER remote_server');
    expect(builder.addSql.firstCall.args[0]).to.include("OPTIONS (schema_name 'remote', table_name 'orders')");
    expect(builder.addSql.getCall(1).args[0]).to.equal(ForeignTableSQL.queryData('public', 'remote_orders'));
    expect(builder.addSql.getCall(2).args[0]).to.equal(ForeignTableSQL.edit('public', 'remote_orders'));
    expect(builder.addSql.getCall(3).args[0]).to.equal(ForeignTableSQL.drop('public', 'remote_orders'));
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('builds the foreign table edit notebook', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub();
    queryStub.resolves({
      rows: [
        {
          table_name: 'remote_orders',
          server_name: 'remote_server',
          columns: ['id integer NOT NULL', 'customer_name text'],
          options: ["schema_name 'remote'", "table_name 'orders'"]
        }
      ]
    });
    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);

    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'remote_orders' } as any;

    await foreignTables.cmdEditForeignTable(item, {} as any);

    expect(queryStub.calledOnceWithExactly(QueryBuilder.foreignTableDefinition('public', 'remote_orders'))).to.be.true;
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Edit Foreign Table: `public.remote_orders`');
    expect(builder.addSql.calledOnce).to.be.true;
    expect(builder.addSql.firstCall.args[0]).to.include('DROP FOREIGN TABLE IF EXISTS public.remote_orders;');
    expect(builder.addSql.firstCall.args[0]).to.include('CREATE FOREIGN TABLE public.remote_orders');
    expect(builder.addSql.firstCall.args[0]).to.include('SERVER remote_server');
    expect(builder.addSql.firstCall.args[0]).to.include("OPTIONS (\n    schema_name 'remote',\n    table_name 'orders'\n)");
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('builds the create notebook from foreign table templates', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);

    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'remote_orders' } as any;

    await foreignTables.cmdCreateForeignTable(item, {} as any);

    expect(builder.addSql.callCount).to.equal(5);
    expect(builder.addSql.getCall(0).args[0]).to.equal(ForeignTableSQL.create.basic('public'));
    expect(builder.addSql.getCall(1).args[0]).to.equal(ForeignTableSQL.create.postgresRemote('public'));
    expect(builder.addSql.getCall(2).args[0]).to.equal(ForeignTableSQL.create.fileBased('public'));
    expect(builder.addSql.getCall(3).args[0]).to.equal(ForeignTableSQL.queryWithJoin('public'));
    expect(builder.addSql.getCall(4).args[0]).to.equal(ForeignTableSQL.manageForeignServer());
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('builds the properties notebook from foreign table metadata', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub();
    queryStub.onFirstCall().resolves({
      rows: [
        {
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: "nextval('remote_orders_id_seq'::regclass)",
          server_name: 'remote_server',
          options: ["schema_name 'remote'", "table_name 'orders'"]
        },
        {
          column_name: 'customer_name',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
          server_name: 'remote_server',
          options: ["schema_name 'remote'", "table_name 'orders'"]
        }
      ]
    });
    queryStub.onSecondCall().resolves({
      rows: [
        {
          table_name: 'remote_orders',
          server_name: 'remote_server',
          columns: ['id integer NOT NULL', 'customer_name text'],
          options: ["schema_name 'remote'", "table_name 'orders'"]
        }
      ]
    });
    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);

    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'remote_orders' } as any;

    await foreignTables.cmdShowForeignTableProperties(item, {} as any);

    expect(queryStub.firstCall.args[0]).to.equal(QueryBuilder.foreignTableInfo('public', 'remote_orders'));
    expect(queryStub.secondCall.args[0]).to.equal(QueryBuilder.foreignTableDefinition('public', 'remote_orders'));
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Foreign Table Properties: `public.remote_orders`');
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Server:');
    expect(builder.addMarkdown.firstCall.args[0]).to.include('Column Count');
    expect(builder.addSql.callCount).to.equal(3);
    expect(builder.addSql.getCall(0).args[0]).to.include('CREATE FOREIGN TABLE public.remote_orders');
    expect(builder.addSql.getCall(1).args[0]).to.equal(ForeignTableSQL.queryData('public', 'remote_orders'));
    expect(builder.addSql.getCall(2).args[0]).to.equal(ForeignTableSQL.drop('public', 'remote_orders'));
    expect(builder.show.calledOnce).to.be.true;
    expect(dbConnection.release.calledOnce).to.be.true;
  });

  it('reports missing foreign table metadata', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub();
    queryStub.onFirstCall().resolves({ rows: [] });
    queryStub.onSecondCall().resolves({
      rows: [
        {
          table_name: 'remote_orders',
          server_name: 'remote_server',
          columns: ['id integer NOT NULL'],
          options: []
        }
      ]
    });
    const dbConnection = createDbConnection({ queryStub });
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const handleCommandError = sandbox.stub(helper.ErrorHandlers, 'handleCommandError').resolves();

    const item = { connectionId: 'conn-1', databaseName: 'db1', schema: 'public', label: 'remote_orders' } as any;

    await foreignTables.cmdShowForeignTableProperties(item, {} as any);

    expect(handleCommandError.calledOnce).to.be.true;
    expect(handleCommandError.firstCall.args[1]).to.equal('show foreign table properties');
    expect(builder.show.called).to.be.false;
    expect(dbConnection.release.calledOnce).to.be.true;
  });
});