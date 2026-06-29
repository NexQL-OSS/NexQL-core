import { expect } from 'chai';
import * as sinon from 'sinon';
import { ConnectionManager } from '../../services/ConnectionManager';
import { SecretStorageService } from '../../services/SecretStorageService';
import type { ConnectionConfig } from '../../common/types';

/** CI uses GitHub Actions service on 5432; local docker-compose.test often maps 5416. */
const TEST_DB_HOST = process.env.DB_HOST || 'localhost';
const TEST_DB_PORT = Number(process.env.DB_PORT || 5432);

function baseConn(overrides: Partial<ConnectionConfig> & { id: string }): ConnectionConfig {
  return {
    host: TEST_DB_HOST,
    port: TEST_DB_PORT,
    database: 'testdb',
    username: 'testuser',
    password: 'testpass',
    sslmode: 'disable',
    ...overrides,
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

describe('Read-only mode integration tests', () => {
  let connectionManager: ConnectionManager;
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    connectionManager = ConnectionManager.getInstance();
    sandbox.stub(SecretStorageService, 'getInstance').returns({
      getPassword: sandbox.stub().resolves(undefined),
    } as any);
  });

  afterEach(async () => {
    sandbox.restore();
    await connectionManager.closeAll();
  });

  it('applies read-only session settings and blocks write statements', async function () {
    this.timeout(15000);

    let probeClient: any;
    try {
      probeClient = await connectionManager.getPooledClient(baseConn({ id: 'readonly-probe' }));
    } catch {
      this.skip();
      return;
    } finally {
      if (probeClient) {
        probeClient.release();
      }
    }

    const tableName = `nexql_readonly_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const quotedTable = quoteIdentifier(tableName);

    const setupConfig = baseConn({ id: 'readonly-setup' });
    const readOnlyConfig = baseConn({ id: 'readonly-session', readOnlyMode: true });

    const setupClient = await connectionManager.getPooledClient(setupConfig);
    let readOnlyClient: any;

    try {
      await setupClient.query(
        `CREATE TABLE ${quotedTable} (id serial PRIMARY KEY, label text NOT NULL)`,
      );
      await setupClient.query(`INSERT INTO ${quotedTable} (label) VALUES ($1)`, ['seed']);

      readOnlyClient = await connectionManager.getPooledClient(readOnlyConfig);
      const modeResult = await readOnlyClient.query('SHOW default_transaction_read_only');
      expect(modeResult.rows[0].default_transaction_read_only).to.equal('on');

      await readOnlyClient.query('BEGIN');
      try {
        await readOnlyClient.query(`INSERT INTO ${quotedTable} (label) VALUES ($1)`, ['blocked']);
        expect.fail('Expected INSERT to fail in read-only mode');
      } catch (error) {
        expect((error as Error).message).to.match(/read-only transaction/i);
      } finally {
        await readOnlyClient.query('ROLLBACK');
      }

      const countResult = await readOnlyClient.query(
        `SELECT count(*)::int AS count FROM ${quotedTable}`,
      );
      expect(countResult.rows[0].count).to.equal(1);
    } finally {
      if (readOnlyClient) {
        readOnlyClient.release();
      }
      try {
        await setupClient.query(`DROP TABLE IF EXISTS ${quotedTable}`);
      } finally {
        setupClient.release();
      }
    }
  });
});
