import { expect } from 'chai';
import * as sinon from 'sinon';

import * as helper from '../../commands/helper';
import * as views from '../../commands/views';
import { CommandBase } from '../../common/commands/CommandBase';
import { QueryBuilder } from '../../commands/helper';
import { ViewSQL } from '../../commands/sql/views';

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

describe('view commands', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function createItem() {
    return {
      connectionId: 'c1',
      databaseName: 'appdb',
      schema: 'public',
      label: 'active_users'
    } as any;
  }

  it('covers the simple view notebook commands and refresh action', async () => {
    const builder = createBuilderStub(sandbox);
    const runStub = sandbox.stub(CommandBase, 'run').callsFake(async (_context, _item, _operation, action) => {
      return await action({}, { query: sandbox.stub().resolves({ rows: [{ definition: 'SELECT 1' }] }) }, { databaseName: 'appdb' });
    });
    const refreshStub = sandbox.stub();

    const item = createItem();
    const context = {} as any;

    await views.cmdScriptSelect(item, context);
    await views.cmdScriptCreate(item, context);
    await views.cmdViewData(item, context);
    await views.cmdDropView(item, context);
    await views.cmdCreateView(item, context);
    await views.cmdRefreshView(item, context, { refresh: refreshStub } as any);

    expect(runStub.callCount).to.equal(5);
    expect(refreshStub.calledOnceWithExactly(item)).to.be.true;
    expect(builder.show.callCount).to.equal(5);
    expect(builder.addSql.firstCall.args[0]).to.equal(ViewSQL.select('public', 'active_users'));
    expect(builder.addSql.getCall(1).args[0]).to.contain('CREATE OR REPLACE VIEW public.active_users AS');
    expect(builder.addSql.getCall(2).args[0]).to.equal(ViewSQL.select('public', 'active_users'));
    expect(builder.addSql.getCall(3).args[0]).to.contain('DROP VIEW IF EXISTS "public"."active_users";');
    expect(builder.addSql.getCall(4).args[0]).to.include('CREATE OR REPLACE VIEW "public"."new_view" AS');
  });

  it('builds the editable view notebook and the full properties notebook', async () => {
    const builder = createBuilderStub(sandbox);
    const queryStub = sandbox.stub();
    queryStub.onCall(0).resolves({ rows: [{ definition: 'SELECT id, name FROM public.users' }] });
    queryStub.onCall(1).resolves({
      rows: [
        {
          schema_name: 'public',
          view_name: 'active_users',
          owner: 'postgres',
          comment: "Shows active users",
          row_estimate: 12
        }
      ]
    });
    queryStub.onCall(2).resolves({
      rows: [
        {
          column_name: 'id',
          data_type: 'integer',
          character_maximum_length: null,
          numeric_precision: null,
          numeric_scale: null,
          ordinal_position: 1,
          is_nullable: 'NO',
          column_default: null,
          description: 'Primary key'
        },
        {
          column_name: 'name',
          data_type: 'text',
          character_maximum_length: null,
          numeric_precision: null,
          numeric_scale: null,
          ordinal_position: 2,
          is_nullable: 'YES',
          column_default: null,
          description: 'Display name'
        }
      ]
    });
    queryStub.onCall(3).resolves({ rows: [{ kind: 'view', schema: 'public', name: 'base_users' }] });
    queryStub.onCall(4).resolves({ rows: [{ kind: 'table', schema: 'public', name: 'user_roles' }] });
    queryStub.onCall(5).resolves({ rows: [{ view_size: '42 MB' }] });
    queryStub.onCall(6).resolves({ rows: [{ definition: 'SELECT id, name FROM public.users' }] });

    const runStub = sandbox.stub(CommandBase, 'run').callsFake(async (_context, _item, _operation, action) => {
      return await action({}, { query: queryStub }, { databaseName: 'appdb' });
    });
    const showErrorStub = sandbox.stub();

    const item = createItem();
    await views.cmdEditView(item, {} as any);
    await views.cmdViewOperations(item, {} as any);
    await views.cmdShowViewProperties(item, {} as any);

    expect(runStub.callCount).to.equal(3);
    expect(queryStub.firstCall.args[0]).to.equal(QueryBuilder.viewDefinition('public', 'active_users'));
    expect(builder.addMarkdown.callCount).to.be.greaterThan(5);
    expect(builder.addSql.called).to.be.true;
    expect(builder.addSql.getCall(0).args[0]).to.contain('CREATE OR REPLACE VIEW public.active_users AS');
    expect(builder.addSql.getCall(1).args[0]).to.equal(ViewSQL.select('public', 'active_users'));
    expect(builder.addSql.getCalls().some((call) => String(call.args[0]).includes('SELECT id, name FROM public.users'))).to.be.true;
    expect(builder.addSql.getCalls().some((call) => String(call.args[0]).includes('DROP VIEW IF EXISTS "public"."active_users";'))).to.be.true;
    expect(builder.show.calledThrice).to.be.true;
  });
});