import { expect } from 'chai';
import { escapeLikePattern } from '../../commands/schemaSearch';

describe('schemaSearch escapeLikePattern', () => {
  const cases: Array<{ input: string; expected: string }> = [
    { input: 'plain', expected: 'plain' },
    { input: '50%', expected: '50\\%' },
    { input: 'a_b', expected: 'a\\_b' },
    { input: 'x\\y', expected: 'x\\\\y' },
  ];

  for (const { input, expected } of cases) {
    it(`escapes ${JSON.stringify(input)}`, () => {
      expect(escapeLikePattern(input)).to.equal(expected);
    });
  }
});
