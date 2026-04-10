import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as helper from '../../commands/helper';
import * as columnCommands from '../../commands/columns';
import { QueryBuilder } from '../../commands/helper';
import { ColumnSQL } from '../../commands/sql/columns';
import { DatabaseTreeItem } from '../../providers/DatabaseTreeProvider';

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

function createDbConnection() {
  const release = sinon.stub();
  const query = sinon.stub();
  return {
    client: { query },
    metadata: {
      connectionId: 'c1',
      databaseName: 'appdb',
      name: 'Primary',
      host: 'localhost',
      port: 5432,
      username: 'postgres'
    },
    release,
    query
  };
}

describe('column commands', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function createItem(): DatabaseTreeItem {
    return {
      label: 'customer_name',
      schema: 'public',
      tableName: 'customers',
      columnName: 'customer_name',
      connectionId: 'c1',
      databaseName: 'appdb'
    } as any;
  }

  it('shows column properties and reports missing columns', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    dbConnection.query.onCall(0).resolves({
      rows: [
        {
          column_name: 'customer_name',
          data_type: 'character varying',
          character_maximum_length: 50,
          numeric_precision: null,
          numeric_scale: null,
          udt_name: 'varchar',
          ordinal_position: 2,
          is_nullable: 'NO',
          column_default: "''",
          is_primary_key: true,
          is_foreign_key: true,
          foreign_table_schema: 'public',
          foreign_table_name: 'users',
          foreign_column_name: 'id',
          is_unique: true,
          column_comment: 'Customer display name'
        }
      ]
    });
    dbConnection.query.onCall(1).resolves({ rows: [] });

    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const errorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

    const item = createItem();
    await columnCommands.showColumnProperties(item);
    await columnCommands.showColumnProperties(item);

    expect(dbConnection.query.firstCall.args[0]).to.equal(QueryBuilder.columnDetails('public', 'customers', 'customer_name'));
    expect(builder.addMarkdown.callCount).to.be.greaterThan(1);
    expect(builder.addSql.calledOnce).to.be.true;
    expect(builder.show.calledOnce).to.be.true;
    expect(errorStub.calledOnceWithExactly('Column not found')).to.be.true;
    expect(dbConnection.release.callCount).to.equal(2);
  });

  it('copies names and builds select, where, alter, and drop notebooks', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const clipboardStub = sandbox.stub(vscode.env.clipboard, 'writeText').resolves();
    const infoStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    const item = createItem();
    await columnCommands.copyColumnName(item);
    await columnCommands.copyColumnNameQuoted(item);
    await columnCommands.generateSelectStatement(item);
    await columnCommands.generateWhereClause(item);
    await columnCommands.generateAlterColumnScript(item);
    await columnCommands.generateDropColumnScript(item);

    expect(clipboardStub.firstCall.args[0]).to.equal('customer_name');
    expect(clipboardStub.secondCall.args[0]).to.equal('"customer_name"');
    expect(infoStub.calledTwice).to.be.true;
    expect(builder.show.callCount).to.equal(4);
    expect(builder.addSql.firstCall.args[0]).to.equal(ColumnSQL.select('public', 'customers', 'customer_name'));
    expect(builder.addSql.getCall(1).args[0]).to.contain('WHERE customer_name =');
    expect(builder.addSql.getCall(2).args[0]).to.equal(ColumnSQL.alter('public', 'customers', 'customer_name'));
    expect(builder.addSql.getCall(3).args[0]).to.equal(ColumnSQL.drop('public', 'customers', 'customer_name'));
    expect(dbConnection.release.callCount).to.equal(4);
  });

  it('builds rename, comment, index, statistics, and add-column notebooks', async () => {
    const builder = createBuilderStub(sandbox);
    const dbConnection = createDbConnection();
    sandbox.stub(helper, 'getDatabaseConnection').resolves(dbConnection as any);
    const inputStub = sandbox.stub(vscode.window, 'showInputBox');
    inputStub.onCall(0).resolves('renamed_customer_name');
    inputStub.onCall(1).resolves('customer_name');
    inputStub.onCall(2).resolves('Customer display name');
    inputStub.onCall(3).resolves('idx_customers_customer_name');

    const item = createItem();
    await columnCommands.generateRenameColumnScript(item);
    await columnCommands.generateRenameColumnScript(item);
    await columnCommands.addColumnComment(item);
    await columnCommands.generateIndexOnColumn(item);
    await columnCommands.viewColumnStatistics(item);
    await columnCommands.cmdAddColumn(item);

    expect(builder.show.callCount).to.equal(5);
    expect(builder.addSql.firstCall.args[0]).to.equal(ColumnSQL.rename('public', 'customers', 'customer_name', 'renamed_customer_name'));
    expect(builder.addSql.getCall(1).args[0]).to.contain('COMMENT ON COLUMN public.customers.customer_name IS');
    expect(builder.addSql.getCall(2).args[0]).to.equal(ColumnSQL.createIndex('public', 'customers', 'customer_name', 'idx_customers_customer_name'));
    expect(builder.addSql.getCall(3).args[0]).to.contain('FROM pg_stats');
    expect(builder.addSql.getCall(4).args[0]).to.contain('ALTER TABLE public.customers');
    expect(dbConnection.release.callCount).to.equal(6);
  });
});