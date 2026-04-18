import { expect } from 'chai';
import { computeColumnStats } from '../../features/analyst/columnAggregates';
import { buildHistogram } from '../../features/analyst/histogram';
import { computePivot } from '../../features/analyst/pivot';
import { coerceNumber } from '../../features/analyst/coerceNumeric';

describe('AnalystTools', () => {
  describe('coerceNumber', () => {
    it('parses numbers and numeric strings', () => {
      expect(coerceNumber(42)).to.equal(42);
      expect(coerceNumber('3.5')).to.equal(3.5);
      expect(coerceNumber(null)).to.equal(null);
      expect(coerceNumber('x')).to.equal(null);
    });
  });

  describe('computeColumnStats', () => {
    it('summarizes numeric and text columns', () => {
      const rows = [
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
        { a: null, b: null },
      ];
      const stats = computeColumnStats(rows, ['a', 'b'], { a: 'int4', b: 'text' });
      expect(stats).to.have.length(2);
      const a = stats.find((s) => s.column === 'a');
      expect(a?.nonNullCount).to.equal(2);
      expect(a?.nullCount).to.equal(1);
      expect(a?.numeric?.sum).to.equal(3);
      expect(a?.numeric?.avg).to.equal(1.5);
      const b = stats.find((s) => s.column === 'b');
      expect(b?.numeric).to.equal(undefined);
      expect(b?.distinctCount).to.equal(2);
    });
  });

  describe('buildHistogram', () => {
    it('builds buckets for a numeric series', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ v: i }));
      const h = buildHistogram(rows, 'v', { bucketCount: 4 });
      expect(h.error).to.equal(undefined);
      expect(h.bucketLabels).to.have.length(4);
      expect(h.counts.reduce((s, c) => s + c, 0)).to.equal(20);
    });

    it('returns error when no numeric values', () => {
      const h = buildHistogram([{ v: 'a' }], 'v', {});
      expect(h.error).to.match(/numeric/i);
    });
  });

  describe('computePivot', () => {
    it('pivots with count aggregation', () => {
      const rows = [
        { region: 'EU', quarter: 'Q1', amount: 10 },
        { region: 'EU', quarter: 'Q1', amount: 20 },
        { region: 'US', quarter: 'Q1', amount: 5 },
      ];
      const p = computePivot(rows, 'region', 'quarter', undefined, 'count');
      if ('error' in p) {
        expect.fail(p.error);
      }
      expect(p.rowLabels).to.deep.equal(['EU', 'US']);
      expect(p.colLabels).to.deep.equal(['Q1']);
      expect(p.cells[0][0]).to.equal(2);
      expect(p.cells[1][0]).to.equal(1);
    });

    it('rejects high-cardinality dimensions', () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({ a: i, b: 0, c: 1 }));
      const p = computePivot(rows, 'a', 'b', 'c', 'sum');
      expect('error' in p).to.equal(true);
    });

    it('sums values per cell', () => {
      const rows = [
        { region: 'EU', quarter: 'Q1', amount: 10 },
        { region: 'EU', quarter: 'Q1', amount: 20 },
      ];
      const p = computePivot(rows, 'region', 'quarter', 'amount', 'sum');
      if ('error' in p) {
        expect.fail(p.error);
      }
      expect(p.cells[0][0]).to.equal(30);
    });
  });
});
