import { expect } from 'chai';
import type { NoticeLogEntry } from '../../common/types';
import { filterNoticeEntries } from '../../renderer/components/notices/NoticesPanel';

const n = (message: string, receivedAt = ''): NoticeLogEntry => ({ message, receivedAt });

describe('filterNoticeEntries', () => {
  const cases: {
    name: string;
    messages: NoticeLogEntry[];
    query: string;
    want: { order: number; text: string; receivedAt: string }[];
  }[] = [
    {
      name: 'empty query returns all in order',
      messages: [n('alpha'), n('beta')],
      query: '',
      want: [
        { order: 1, text: 'alpha', receivedAt: '' },
        { order: 2, text: 'beta', receivedAt: '' },
      ],
    },
    {
      name: 'case-insensitive substring',
      messages: [n('Hello World'), n('no match')],
      query: 'world',
      want: [{ order: 1, text: 'Hello World', receivedAt: '' }],
    },
    {
      name: 'whitespace-only query acts as no filter',
      messages: [n('x')],
      query: '   ',
      want: [{ order: 1, text: 'x', receivedAt: '' }],
    },
    {
      name: 'preserves original indices when filtered',
      messages: [n('a'), n('b'), n('alpha')],
      query: 'a',
      want: [
        { order: 1, text: 'a', receivedAt: '' },
        { order: 3, text: 'alpha', receivedAt: '' },
      ],
    },
  ];

  cases.forEach(({ name, messages, query, want }) => {
    it(name, () => {
      expect(filterNoticeEntries(messages, query)).to.deep.equal(want);
    });
  });
});
