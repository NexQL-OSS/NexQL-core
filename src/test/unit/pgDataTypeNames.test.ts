import { expect } from 'chai';
import * as pgTypes from 'pg-types';
import { getPgDataTypeName } from '../../common/pgDataTypeNames';

describe('getPgDataTypeName', () => {
  it('maps builtin OIDs to pg typnames (json / jsonb)', () => {
    expect(getPgDataTypeName(pgTypes.builtins.JSON)).to.equal('json');
    expect(getPgDataTypeName(pgTypes.builtins.JSONB)).to.equal('jsonb');
  });

  it('returns oid:<n> for unknown types instead of a misleading generic label', () => {
    expect(getPgDataTypeName(999_001)).to.equal('oid:999001');
  });
});
