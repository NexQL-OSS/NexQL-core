import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as connectionModule from '../../commands/connection';
import {
  ErrorHandlers,
  FormatHelpers,
  MarkdownUtils,
  NotebookBuilder,
  ObjectUtils,
  StringUtils,
  ValidationHelpers,
  getDatabaseConnection,
  validateCategoryItem,
  validateItem,
  validateNotebookContextItem,
  validateRoleItem,
} from '../../commands/helper';
import { ConnectionManager } from '../../services/ConnectionManager';
import { ErrorService } from '../../services/ErrorService';
import { DatabaseTreeItem } from '../../providers/DatabaseTreeProvider';

describe('CommandHelper utilities', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('validates tree item helpers', () => {
    expect(() => validateItem({} as any)).to.throw('Invalid selection');
    expect(() => validateCategoryItem({} as any)).to.throw('Invalid category selection');
    expect(() => validateRoleItem({} as any)).to.throw('Invalid role selection');

    expect(() => validateItem({ connectionId: 'c1', schema: 'public' } as any)).not.to.throw();
    expect(() => validateCategoryItem({ connectionId: 'c1' } as any)).not.to.throw();
    expect(() => validateRoleItem({ connectionId: 'c1' } as any)).not.to.throw();

    expect(() => validateNotebookContextItem({} as any)).to.throw('Invalid selection');
    expect(() => validateNotebookContextItem({ connectionId: 'c1' } as any)).to.throw('Invalid selection');
    expect(() => validateNotebookContextItem({ connectionId: 'c1', databaseName: 'db1' } as any)).not.to.throw();
  });

  it('covers markdown, formatting, validation, and string helpers', () => {
    expect(MarkdownUtils.operationsTable([
      { operation: 'Drop', description: 'Remove a table', riskLevel: 'High' },
    ])).to.contain('Risk Level');
    expect(MarkdownUtils.operationsTable([
      { operation: 'Select', description: 'Read rows' },
    ])).to.not.contain('Risk Level');
    expect(MarkdownUtils.propertiesTable({ Owner: 'alice', Size: '1 MB' })).to.contain('Owner');
    expect(MarkdownUtils.header('Title', 'Subtitle')).to.contain('### Title');

    expect(ObjectUtils.getKindLabel('r')).to.equal('📊 Table');
    expect(ObjectUtils.getKindLabel('unknown')).to.equal('unknown');
    expect(ObjectUtils.getConstraintIcon('PRIMARY KEY')).to.equal('🔑');
    expect(ObjectUtils.getConstraintIcon('NOTHING')).to.equal('📌');
    expect(ObjectUtils.getIndexIcon(true, false)).to.equal('🔑');
    expect(ObjectUtils.getIndexIcon(false, true)).to.equal('⭐');
    expect(ObjectUtils.getIndexIcon(false, false)).to.equal('🔍');

    expect(FormatHelpers.formatBytes(0)).to.equal('0 Bytes');
    expect(FormatHelpers.formatBytes(1024)).to.equal('1 KB');
    expect(FormatHelpers.formatBytes(1024 * 1024)).to.equal('1 MB');
    expect(FormatHelpers.formatBoolean(true)).to.contain('Yes');
    expect(FormatHelpers.formatBoolean(false)).to.contain('No');
    expect(FormatHelpers.escapeSqlString("O'Reilly")).to.equal("O''Reilly");
    expect(FormatHelpers.formatArray([])).to.equal('—');
    expect(FormatHelpers.formatArray(['a', 'b'])).to.equal('a, b');
    expect(FormatHelpers.formatNumber(12345)).to.equal('12,345');
    expect(FormatHelpers.formatPercentage(42)).to.equal('42%');

    expect(ValidationHelpers.validateColumnName('column_name')).to.equal(null);
    expect(ValidationHelpers.validateColumnName('')).to.equal('Column name cannot be empty');
    expect(ValidationHelpers.validateColumnName('123bad')).to.contain('Invalid column name');
    expect(ValidationHelpers.validateIdentifier('table_name', 'table')).to.equal(null);
    expect(ValidationHelpers.validateIdentifier('', 'table')).to.equal('table name cannot be empty');
    expect(ValidationHelpers.validateIdentifier('bad-name', 'table')).to.contain('Invalid table name');

    expect(StringUtils.cleanMarkdownCodeBlocks('```sql\nSELECT 1;\n```')).to.equal('SELECT 1;');
    expect(StringUtils.cleanMarkdownCodeBlocks('```\nSELECT 2;\n```')).to.equal('SELECT 2;');
    expect(StringUtils.truncate('short', 10)).to.equal('short');
    expect(StringUtils.truncate('this is definitely long', 10)).to.equal('this is...');
  });

  it('covers NotebookBuilder cell collection helpers', () => {
    const builder = new NotebookBuilder({ connectionId: 'c1', databaseName: 'db1' });
    builder.addMarkdown('hello').addSql('SELECT 1');

    expect((builder as any).cells).to.have.lengthOf(2);
    expect((builder as any).cells[0].language).to.equal('markdown');
    expect((builder as any).cells[1].language).to.equal('sql');
  });

  it('gets database connection and releases the pooled client', async () => {
    const item = new DatabaseTreeItem('users', vscode.TreeItemCollapsibleState.Collapsed, 'table', 'conn-1', 'db1', 'public');
    const connection = {
      id: 'conn-1',
      name: 'Primary',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'db1',
    };
    const client = { release: sandbox.stub() };
    const pooledClient = sandbox.stub().resolves(client);

    sandbox.stub(connectionModule, 'getConnectionWithPassword').resolves(connection as any);
    sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient: pooledClient } as any);

    const result = await getDatabaseConnection(item);

    expect(connectionModule.getConnectionWithPassword.calledOnceWithExactly('conn-1', 'db1')).to.be.true;
    expect(pooledClient.calledOnce).to.be.true;
    expect(result.connection).to.equal(connection);
    expect(result.client).to.equal(client);
    expect(result.metadata).to.include({ connectionId: 'conn-1', databaseName: 'db1', name: 'Primary' });

    result.release();
    expect((client.release as sinon.SinonStub).calledOnce).to.be.true;
  });

  it('propagates validation failures from getDatabaseConnection', async () => {
    const item = new DatabaseTreeItem('users', vscode.TreeItemCollapsibleState.Collapsed, 'table', 'conn-1', 'db1', 'public');

    try {
      await getDatabaseConnection(item, () => {
        throw new Error('bad selection');
      });
      expect.fail('expected getDatabaseConnection to throw');
    } catch (err) {
      expect((err as Error).message).to.equal('bad selection');
    }
  });

  it('forwards helper errors to ErrorService', async () => {
    const showError = sandbox.stub().resolves();
    const handleCommandError = sandbox.stub().resolves();
    sandbox.stub(ErrorService, 'getInstance').returns({ showError, handleCommandError } as any);

    await ErrorHandlers.showError('boom', 'Retry', 'cmd.retry');
    await ErrorHandlers.handleCommandError(new Error('fail'), 'save changes');

    expect(showError.calledOnceWithExactly('boom', 'Retry', 'cmd.retry')).to.be.true;
    expect(handleCommandError.calledOnce).to.be.true;
  });
});