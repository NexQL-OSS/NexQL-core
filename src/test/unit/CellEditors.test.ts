import { expect } from 'chai';
import { getEditorType } from '../../renderer/components/table/CellEditors';

describe('getEditorType', () => {
  const cases: { type: string; value: unknown; expected: ReturnType<typeof getEditorType> }[] = [
    { type: 'jsonb', value: {}, expected: 'json' },
    { type: 'varchar', value: 'hi', expected: 'longtext' },
    { type: 'text', value: '', expected: 'longtext' },
    { type: 'xml', value: '<a/>', expected: 'longtext' },
    { type: 'interval', value: '1 day', expected: 'longtext' },
    { type: 'path', value: '[(0,0),(1,1)]', expected: 'longtext' },
    { type: 'polygon', value: '((0,0),(1,1),(1,0))', expected: 'longtext' },
    { type: 'box', value: '(1,1),(0,0)', expected: 'longtext' },
    { type: 'line', value: '{1,2,3}', expected: 'longtext' },
    { type: 'varchar(64)', value: 'x', expected: 'longtext' },
    { type: 'numeric(10,2)', value: '1.00', expected: 'longtext' },
    { type: 'int4range', value: '[1,10)', expected: 'longtext' },
    { type: 'bytea', value: '\\xdead', expected: 'longtext' },
    { type: 'uuid', value: '00000000-0000-0000-0000-000000000000', expected: 'longtext' },
    { type: 'money', value: '12.34', expected: 'longtext' },
    { type: 'oid:12345', value: 'enum_val', expected: 'longtext' },
    { type: 'int4', value: 1, expected: 'number' },
    { type: 'unknown', value: 'x'.repeat(201), expected: 'longtext' },
    { type: '', value: 'short', expected: 'text' },
  ];

  cases.forEach(({ type, value, expected }) => {
    it(`maps ${JSON.stringify(type)} to ${expected}`, () => {
      expect(getEditorType(type, value)).to.equal(expected);
    });
  });
});
