import { expect } from 'chai';
import { buildMigrationStatements, computeSchemaDiff } from '../../features/schemaDiff/SchemaDiffEngine';
import type { SchemaSnapshot, TableSnapshot } from '../../features/schemaDiff/schemaDiffTypes';

function table(
  name: string,
  schema: string,
  columns: TableSnapshot['columns'],
  constraints: TableSnapshot['constraints'] = [],
  indexes: TableSnapshot['indexes'] = [],
): TableSnapshot {
  return { name, schema, columns, constraints, indexes };
}

describe('SchemaDiffEngine', () => {
  describe('computeSchemaDiff', () => {
    it('returns empty when both snapshots have no tables', () => {
      const a: SchemaSnapshot = { tables: [] };
      const b: SchemaSnapshot = { tables: [] };
      expect(computeSchemaDiff(a, b)).to.deep.equal([]);
    });

    it('detects table added only in target', () => {
      const source: SchemaSnapshot = { tables: [] };
      const target: SchemaSnapshot = {
        tables: [
          table('t1', 'public', [
            {
              column_name: 'id',
              data_type: 'integer',
              not_null: true,
              default_value: null,
              ordinal: 1,
            },
          ]),
        ],
      };
      const diffs = computeSchemaDiff(source, target);
      expect(diffs).to.have.lengthOf(1);
      expect(diffs[0].name).to.equal('t1');
      expect(diffs[0].status).to.equal('added');
      expect(diffs[0].columnDiffs[0].status).to.equal('added');
    });

    it('detects column type change', () => {
      const colA = {
        column_name: 'x',
        data_type: 'integer',
        not_null: false,
        default_value: null,
        ordinal: 1,
      };
      const colB = { ...colA, data_type: 'bigint' };
      const source: SchemaSnapshot = {
        tables: [table('t1', 'public', [colA])],
      };
      const target: SchemaSnapshot = {
        tables: [table('t1', 'public', [colB])],
      };
      const diffs = computeSchemaDiff(source, target);
      expect(diffs[0].status).to.equal('changed');
      const cd = diffs[0].columnDiffs.find((c) => c.name === 'x');
      expect(cd?.status).to.equal('changed');
    });
  });

  describe('buildMigrationStatements', () => {
    const cases: Array<{
      title: string;
      sourceSchema: string;
      targetSchema: string;
      build: () => ReturnType<typeof computeSchemaDiff>;
      expectSnippet: string;
    }> = [
      {
        title: 'ADD COLUMN in changed table',
        sourceSchema: 'public',
        targetSchema: 'public',
        build: () =>
          computeSchemaDiff(
            { tables: [table('t1', 'public', [])] },
            {
              tables: [
                table('t1', 'public', [
                  {
                    column_name: 'n',
                    data_type: 'text',
                    not_null: false,
                    default_value: null,
                    ordinal: 1,
                  },
                ]),
              ],
            },
          ),
        expectSnippet: 'ADD COLUMN "n"',
      },
      {
        title: 'CREATE TABLE for new table in target',
        sourceSchema: 'app',
        targetSchema: 'app',
        build: () =>
          computeSchemaDiff({ tables: [] }, {
            tables: [
              table(
                'new_t',
                'app',
                [
                  {
                    column_name: 'id',
                    data_type: 'uuid',
                    not_null: true,
                    default_value: null,
                    ordinal: 1,
                  },
                ],
                [],
                [],
              ),
            ],
          }),
        expectSnippet: 'CREATE TABLE "app"."new_t"',
      },
    ];

    for (const { title, sourceSchema, targetSchema, build, expectSnippet } of cases) {
      it(title, () => {
        const sql = buildMigrationStatements(sourceSchema, targetSchema, build()).join('\n');
        expect(sql).to.include(expectSnippet);
      });
    }
  });
});
