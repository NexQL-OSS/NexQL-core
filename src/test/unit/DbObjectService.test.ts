import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { DbObjectService } from '../../providers/chat/DbObjectService';
import { ConnectionManager } from '../../services/ConnectionManager';

type QueryResponse = {
  match: string;
  rows: any[];
};

function createQueryClient(sandbox: sinon.SinonSandbox, responses: QueryResponse[]) {
  const query = sandbox.stub().callsFake(async (sql: string) => {
    const response = responses.find(entry => sql.includes(entry.match));
    if (!response) {
      throw new Error(`Unexpected query: ${sql}`);
    }

    return { rows: response.rows };
  });

  const release = sandbox.stub();

  return { query, release };
}

function createConnectionConfig(connections: any[]) {
  return {
    get: (key: string) => {
      if (key === 'postgresExplorer.connections') {
        return connections;
      }

      return undefined;
    }
  } as any;
}

function createHarness(
  sandbox: sinon.SinonSandbox,
  connections: any[],
  clientResolver: (config: any) => any
) {
  sandbox.stub(vscode.workspace, 'getConfiguration').returns(createConnectionConfig(connections));

  const getPooledClient = sandbox.stub().callsFake(async (config: any) => clientResolver(config));
  sandbox.stub(ConnectionManager, 'getInstance').returns({ getPooledClient } as any);

  const service = new DbObjectService();
  const dbListCache = {
    getOrFetch: sandbox.stub().callsFake(async (_key: string, fetcher: () => Promise<any>) => fetcher()),
    clear: sandbox.stub()
  };

  (service as any)._dbListCache = dbListCache;

  return { service, getPooledClient, dbListCache };
}

describe('DbObjectService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('maps configured connections to top-level objects', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns(createConnectionConfig([
      { id: 'conn1', host: 'db.local', name: 'Primary' },
      { id: 'conn2', host: 'db2.local' }
    ]));

    const service = new DbObjectService();
    const connections = await service.getConnections();

    expect(connections).to.deep.equal([
      {
        name: 'Primary',
        type: 'connection',
        schema: '',
        database: '',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary',
        isContainer: true
      },
      {
        name: 'db2.local',
        type: 'connection',
        schema: '',
        database: '',
        connectionId: 'conn2',
        connectionName: 'db2.local',
        breadcrumb: 'db2.local',
        isContainer: true
      }
    ]);
  });

  it('loads databases, schemas, and schema objects through pooled clients', async () => {
    const postgresClient = createQueryClient(sandbox, [
      {
        match: 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
        rows: [{ datname: 'appdb' }]
      }
    ]);

    const appClient = createQueryClient(sandbox, [
      {
        match: 'SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE',
        rows: [{ nspname: 'public' }]
      },
      {
        match: "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
        rows: [{ table_name: 'users' }]
      },
      {
        match: 'SELECT table_name FROM information_schema.views WHERE table_schema = $1',
        rows: [{ table_name: 'active_users' }]
      },
      {
        match: "SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = 'FUNCTION'",
        rows: [{ routine_name: 'calc_total' }]
      },
      {
        match: 'SELECT matviewname FROM pg_matviews WHERE schemaname = $1',
        rows: [{ matviewname: 'user_summary' }]
      }
    ]);

    const { service, getPooledClient } = createHarness(
      sandbox,
      [{ id: 'conn1', host: 'db.local', port: 5432, username: 'postgres', name: 'Primary' }],
      (config: any) => config.database === 'postgres' ? postgresClient : appClient
    );

    const databases = await service.getDatabases('conn1');
    expect(databases).to.deep.equal([
      {
        name: 'appdb',
        type: 'database',
        schema: '',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb',
        isContainer: true
      }
    ]);

    const schemas = await service.getSchemas('conn1', 'appdb');
    expect(schemas).to.deep.equal([
      {
        name: 'public',
        type: 'schema',
        schema: 'public',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > public',
        isContainer: true
      }
    ]);

    const objects = await service.getSchemaObjects('conn1', 'appdb', 'public');
    expect(objects.map(object => object.type)).to.deep.equal([
      'table',
      'view',
      'function',
      'materialized-view'
    ]);
    expect(objects[0]).to.include({
      name: 'users',
      schema: 'public',
      database: 'appdb',
      connectionId: 'conn1',
      connectionName: 'Primary'
    });

    expect(getPooledClient.callCount).to.equal(3);
    expect(postgresClient.release.called).to.be.false;
    expect(appClient.release.called).to.be.false;
  });

  it('uses the lightweight initial search query and stores the result cache', async () => {
    const postgresClient = createQueryClient(sandbox, [
      {
        match: 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
        rows: [{ datname: 'appdb' }]
      }
    ]);

    const appClient = createQueryClient(sandbox, [
      {
        match: 'ORDER BY c.relpages DESC NULLS LAST',
        rows: [{ type: 'table', schema: 'public', name: 'users' }]
      }
    ]);

    const { service } = createHarness(
      sandbox,
      [{ id: 'conn1', host: 'db.local', port: 5432, username: 'postgres', name: 'Primary' }],
      (config: any) => config.database === 'postgres' ? postgresClient : appClient
    );

    const initialObjects = await service.getInitialObjects();

    expect(initialObjects).to.deep.equal([
      {
        name: 'users',
        type: 'table',
        schema: 'public',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > public > users'
      }
    ]);
    expect(service.getCache()).to.deep.equal(initialObjects);
  });

  it('searches objects and reuses the last query result', async () => {
    const cachedObjects = [
      {
        name: 'cached_users',
        type: 'table',
        schema: 'public',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > public > cached_users'
      },
      {
        name: 'cached_view',
        type: 'view',
        schema: 'analytics',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > analytics > cached_view'
      }
    ];

    const postgresClient = createQueryClient(sandbox, [
      {
        match: 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
        rows: [{ datname: 'appdb' }]
      }
    ]);

    const appClient = createQueryClient(sandbox, [
      {
        match: "c.relkind IN ('r', 'v', 'm', 'f', 'p')",
        rows: [{ type: 'table', schema: 'public', name: 'users' }]
      }
    ]);

    const { service, getPooledClient } = createHarness(
      sandbox,
      [{ id: 'conn1', host: 'db.local', port: 5432, username: 'postgres', name: 'Primary' }],
      (config: any) => config.database === 'postgres' ? postgresClient : appClient
    );

    (service as any)._cache = cachedObjects;

    const shortResults = await service.searchObjectsAsync('u');
    expect(shortResults).to.deep.equal(cachedObjects.slice(0, 20));
    expect(getPooledClient.called).to.be.false;

    const firstSearch = await service.searchObjectsAsync('us');
    expect(firstSearch).to.deep.equal([
      {
        name: 'users',
        type: 'table',
        schema: 'public',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > public > users'
      }
    ]);

    const callsAfterFirstSearch = getPooledClient.callCount;
    const repeatedSearch = await service.searchObjectsAsync('us');

    expect(repeatedSearch).to.equal(firstSearch);
    expect(getPooledClient.callCount).to.equal(callsAfterFirstSearch);
  });

  it('formats schema details for supported object types and caches the result', async () => {
    const cases = [
      {
        label: 'table',
        object: {
          name: 'users',
          type: 'table',
          schema: 'public',
          database: 'appdb',
          connectionId: 'conn1',
          connectionName: 'Primary',
          breadcrumb: 'Primary > appdb > public > users'
        },
        responses: [
          {
            match: 'character_maximum_length',
            rows: [
              {
                column_name: 'id',
                data_type: 'integer',
                is_nullable: 'NO',
                column_default: 'nextval(users_id_seq)',
                character_maximum_length: null,
                numeric_precision: null,
                numeric_scale: null
              },
              {
                column_name: 'account_id',
                data_type: 'integer',
                is_nullable: 'YES',
                column_default: null,
                character_maximum_length: null,
                numeric_precision: null,
                numeric_scale: null
              }
            ]
          },
          {
            // v1.4.0: PK + FK are fetched in one combined constraint query (P1.2 batching).
            match: "IN ('PRIMARY KEY', 'FOREIGN KEY')",
            rows: [
              {
                constraint_type: 'PRIMARY KEY',
                constraint_name: 'users_pkey',
                column_name: 'id',
                ordinal_position: 1,
                ref_schema: null,
                ref_table: null,
                ref_column: null
              },
              {
                constraint_type: 'FOREIGN KEY',
                constraint_name: 'users_account_id_fkey',
                column_name: 'account_id',
                ordinal_position: 1,
                ref_schema: 'public',
                ref_table: 'accounts',
                ref_column: 'id'
              }
            ]
          },
          {
            match: 'GROUP BY i.relname, ix.indisunique, ix.indisprimary',
            rows: [
              {
                index_name: 'users_pkey',
                indisunique: true,
                indisprimary: true,
                columns: ['id']
              }
            ]
          },
          {
            match: 'reltuples::bigint as estimate',
            rows: [{ estimate: '42' }]
          }
        ],
        assertions: (output: string) => {
          expect(output).to.contain('## Table: public.users');
          expect(output).to.contain('### Columns');
          expect(output).to.contain('### Primary Key');
          expect(output).to.contain('### Foreign Keys');
          expect(output).to.contain('### Indexes');
          expect(output).to.contain('Estimated Row Count: ~42');
        }
      },
      {
        label: 'view',
        object: {
          name: 'active_users',
          type: 'view',
          schema: 'public',
          database: 'appdb',
          connectionId: 'conn1',
          connectionName: 'Primary',
          breadcrumb: 'Primary > appdb > public > active_users'
        },
        responses: [
          {
            match: 'SELECT column_name, data_type FROM information_schema.columns',
            rows: [
              { column_name: 'id', data_type: 'integer' },
              { column_name: 'email', data_type: 'text' }
            ]
          },
          {
            match: 'SELECT definition FROM pg_views',
            rows: [{ definition: 'SELECT users.id, users.email FROM users;' }]
          }
        ],
        assertions: (output: string) => {
          expect(output).to.contain('## View: public.active_users');
          expect(output).to.contain('### Definition');
          expect(output).to.contain('SELECT users.id, users.email FROM users;');
        }
      },
      {
        label: 'function',
        object: {
          name: 'calc_total',
          type: 'function',
          schema: 'public',
          database: 'appdb',
          connectionId: 'conn1',
          connectionName: 'Primary',
          breadcrumb: 'Primary > appdb > public > calc_total'
        },
        responses: [
          {
            match: 'pg_get_functiondef(p.oid) as definition',
            rows: [
              {
                proname: 'calc_total',
                definition: 'CREATE FUNCTION public.calc_total() RETURNS numeric AS $$ SELECT 1; $$ LANGUAGE sql;',
                arguments: 'amount numeric',
                return_type: 'numeric',
                language: 'sql',
                provolatile: 's',
                proisstrict: true
              }
            ]
          }
        ],
        assertions: (output: string) => {
          expect(output).to.contain('## Function: public.calc_total');
          expect(output).to.contain('### Signature');
          expect(output).to.contain('Volatility: STABLE');
          expect(output).to.contain('Strict: Yes');
        }
      },
      {
        label: 'materialized view',
        object: {
          name: 'user_summary',
          type: 'materialized-view',
          schema: 'public',
          database: 'appdb',
          connectionId: 'conn1',
          connectionName: 'Primary',
          breadcrumb: 'Primary > appdb > public > user_summary'
        },
        responses: [
          {
            match: 'format_type(atttypid, atttypmod) as data_type',
            rows: [{ column_name: 'user_id', data_type: 'integer' }]
          },
          {
            match: 'SELECT definition FROM pg_matviews',
            rows: [{ definition: 'SELECT user_id, COUNT(*) FROM events GROUP BY user_id;' }]
          }
        ],
        assertions: (output: string) => {
          expect(output).to.contain('## Materialized View: public.user_summary');
          expect(output).to.contain('### Definition');
          expect(output).to.contain('SELECT user_id, COUNT(*) FROM events GROUP BY user_id;');
        }
      },
      {
        label: 'type',
        object: {
          name: 'address',
          type: 'type',
          schema: 'public',
          database: 'appdb',
          connectionId: 'conn1',
          connectionName: 'Primary',
          breadcrumb: 'Primary > appdb > public > address'
        },
        responses: [
          {
            match: 'pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid',
            rows: [
              { attname: 'street', data_type: 'text' },
              { attname: 'zip', data_type: 'text' }
            ]
          }
        ],
        assertions: (output: string) => {
          expect(output).to.contain('## Type: public.address');
          expect(output).to.contain('### Attributes');
          expect(output).to.contain('| street | text |');
        }
      },
      {
        label: 'schema',
        object: {
          name: 'public',
          type: 'schema',
          schema: 'public',
          database: 'appdb',
          connectionId: 'conn1',
          connectionName: 'Primary',
          breadcrumb: 'Primary > appdb > public'
        },
        responses: [
          {
            match: "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
            rows: [{ table_name: 'users' }]
          },
          {
            match: 'SELECT table_name FROM information_schema.views WHERE table_schema = $1',
            rows: [{ table_name: 'active_users' }]
          },
          {
            match: 'SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1',
            rows: [{ routine_name: 'calc_total' }]
          }
        ],
        assertions: (output: string) => {
          expect(output).to.contain('## Schema: public');
          expect(output).to.contain('### Summary');
          expect(output).to.contain('- Tables: 1');
          expect(output).to.contain('- Views: 1');
          expect(output).to.contain('- Functions: 1');
        }
      },
      {
        label: 'unknown',
        object: {
          name: 'anything',
          type: 'connection',
          schema: '',
          database: 'appdb',
          connectionId: 'conn1',
          connectionName: 'Primary',
          breadcrumb: 'Primary'
        },
        responses: [],
        assertions: (output: string) => {
          expect(output).to.equal('Unknown object type');
        }
      }
    ];

    for (const testCase of cases) {
      const caseSandbox = sinon.createSandbox();
      const client = createQueryClient(caseSandbox, testCase.responses);
      const { service } = createHarness(
        caseSandbox,
        [{ id: 'conn1', host: 'db.local', port: 5432, username: 'postgres', name: 'Primary' }],
        () => client
      );

      const firstResult = await service.getObjectSchema(testCase.object as any);
      testCase.assertions(firstResult);

      const secondResult = await service.getObjectSchema(testCase.object as any);
      expect(secondResult).to.equal(firstResult);
      expect(client.query.callCount).to.equal(testCase.responses.length);
      expect(client.release.calledOnce).to.be.true;

      caseSandbox.restore();
    }
  });

  it('returns a connection-not-found message when the object has no matching connection', async () => {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns(createConnectionConfig([]));

    const service = new DbObjectService();
    const output = await service.getObjectSchema({
      name: 'users',
      type: 'table',
      schema: 'public',
      database: 'appdb',
      connectionId: 'missing',
      connectionName: 'Missing',
      breadcrumb: 'Missing'
    });

    expect(output).to.equal('Connection not found');
  });

  it('clears cached objects and filters cached search results in memory', async () => {
    const { service, dbListCache } = createHarness(
      sandbox,
      [{ id: 'conn1', host: 'db.local', port: 5432, username: 'postgres', name: 'Primary' }],
      () => ({ query: sandbox.stub().resolves({ rows: [] }), release: sandbox.stub() })
    );

    (service as any)._cache = [
      {
        name: 'users',
        type: 'table',
        schema: 'public',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > public > users'
      },
      {
        name: 'active_users',
        type: 'view',
        schema: 'analytics',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > analytics > active_users'
      }
    ];
    (service as any)._objectSchemaCache = new Map([['cache-key', 'cached schema']]);

    expect(service.getCache()).to.have.lengthOf(2);
    expect(service.searchObjects('view')).to.deep.equal([
      {
        name: 'active_users',
        type: 'view',
        schema: 'analytics',
        database: 'appdb',
        connectionId: 'conn1',
        connectionName: 'Primary',
        breadcrumb: 'Primary > appdb > analytics > active_users'
      }
    ]);

    service.clearCache();

    expect((service as any)._objectSchemaCache.size).to.equal(0);
    expect(dbListCache.clear.calledOnce).to.be.true;
  });
});