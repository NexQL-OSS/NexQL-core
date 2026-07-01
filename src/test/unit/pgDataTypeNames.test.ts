import { expect } from 'chai';
import * as pgTypes from 'pg-types';
import { getPgDataTypeName, deduplicateColumns } from '../../common/pgDataTypeNames';

describe('getPgDataTypeName', () => {
  it('maps builtin OIDs to pg typnames (json / jsonb)', () => {
    expect(getPgDataTypeName(pgTypes.builtins.JSON)).to.equal('json');
    expect(getPgDataTypeName(pgTypes.builtins.JSONB)).to.equal('jsonb');
  });

  it('returns oid:<n> for unknown types instead of a misleading generic label', () => {
    expect(getPgDataTypeName(999_001)).to.equal('oid:999001');
  });
});

describe('deduplicateColumns', () => {
  it('keeps unique names intact', () => {
    expect(deduplicateColumns(['a', 'b', 'c'])).to.deep.equal(['a', 'b', 'c']);
  });

  it('deduplicates duplicate column names with a count suffix', () => {
    expect(deduplicateColumns(['coalesce', 'coalesce', 'coalesce'])).to.deep.equal([
      'coalesce',
      'coalesce (1)',
      'coalesce (2)',
    ]);
  });

  it('maps empty/nameless columns to ?column? and deduplicates them', () => {
    expect(deduplicateColumns(['', 'coalesce', '', ''])).to.deep.equal([
      '?column?',
      'coalesce',
      '?column? (1)',
      '?column? (2)',
    ]);
  });
});

