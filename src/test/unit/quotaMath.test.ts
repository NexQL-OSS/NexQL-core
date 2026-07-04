import { expect } from 'chai';
import { periodKey, nextReset, peek, consume } from '../../services/quotaMath';

describe('quotaMath month period', () => {
  it('periodKey groups by calendar month', () => {
    expect(periodKey('month', new Date(2026, 0, 1))).to.equal('2026-01');
    expect(periodKey('month', new Date(2026, 0, 31))).to.equal('2026-01');
    expect(periodKey('month', new Date(2026, 1, 1))).to.equal('2026-02');
  });

  it('nextReset is midnight on the 1st of the following month', () => {
    const reset = nextReset('month', new Date(2026, 0, 15, 10, 30));
    expect(reset.getFullYear()).to.equal(2026);
    expect(reset.getMonth()).to.equal(1);
    expect(reset.getDate()).to.equal(1);
    expect(reset.getHours()).to.equal(0);
  });

  it('nextReset rolls over the year boundary', () => {
    const reset = nextReset('month', new Date(2026, 11, 20));
    expect(reset.getFullYear()).to.equal(2027);
    expect(reset.getMonth()).to.equal(0);
    expect(reset.getDate()).to.equal(1);
  });

  it('peek and consume respect the monthly limit and reset key', () => {
    const quota = { limit: 5, period: 'month' as const };
    const now = new Date(2026, 2, 10);

    let record = undefined;
    for (let i = 0; i < 5; i++) {
      const result = consume(record, quota, now);
      expect(result.allowed).to.equal(true);
      record = result.record;
    }

    const exhausted = consume(record, quota, now);
    expect(exhausted.allowed).to.equal(false);
    expect(exhausted.remaining).to.equal(0);

    const view = peek(record, quota, now);
    expect(view.used).to.equal(5);
    expect(view.remaining).to.equal(0);

    // Usage resets once the month rolls over.
    const nextMonth = new Date(2026, 3, 1);
    const afterReset = peek(record, quota, nextMonth);
    expect(afterReset.used).to.equal(0);
    expect(afterReset.remaining).to.equal(5);
  });
});
