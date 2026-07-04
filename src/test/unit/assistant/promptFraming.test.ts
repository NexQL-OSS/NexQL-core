import { expect } from 'chai';
import { buildDraft } from '../../../services/assistant/promptFraming';
import { AssistantInvocation } from '../../../services/assistant/contextItems';

describe('promptFraming.buildDraft', () => {
  it('renders a resultSample whose rows are record objects (regression: row.map is not a function)', () => {
    const inv: AssistantInvocation = {
      intent: 'ask',
      items: [
        {
          kind: 'resultSample',
          sql: 'SELECT id, name FROM users',
          columns: ['id', 'name'],
          rows: [
            { id: 1, name: 'Ada' },
            { id: 2, name: 'Grace' },
          ],
          totalRowCount: 2,
          truncated: false,
        },
      ],
    };

    const { attachments, draftText } = buildDraft(inv);

    expect(attachments).to.have.length(1);
    expect(attachments[0].name).to.equal('Results · 2 rows');
    expect(attachments[0].content).to.equal('id,name\n1,Ada\n2,Grace');
    expect(draftText).to.include('Returned 2 rows');
  });

  it('escapes commas/quotes in row values', () => {
    const inv: AssistantInvocation = {
      intent: 'ask',
      items: [
        {
          kind: 'resultSample',
          sql: 'SELECT note FROM t',
          columns: ['note'],
          rows: [{ note: 'has, comma and "quote"' }],
          totalRowCount: 1,
          truncated: false,
        },
      ],
    };

    const { attachments } = buildDraft(inv);
    expect(attachments[0].content).to.equal('note\n"has, comma and ""quote"""');
  });

  it('returns an empty draft for a bare dbObject attach with no notes (does not overwrite the composer)', () => {
    const inv: AssistantInvocation = {
      intent: 'ask',
      items: [
        {
          kind: 'dbObject',
          object: {
            name: 'brands',
            type: 'table',
            schema: 'ecom',
            database: 'ecom_star',
            connectionId: 'local',
            connectionName: 'local',
            breadcrumb: 'local > ecom_star > ecom > brands',
          },
        },
      ],
    };

    const { draftText, attachments } = buildDraft(inv);
    expect(draftText).to.equal('');
    expect(attachments).to.have.length(0);
  });

  it('respects an explicit draftText override', () => {
    const inv: AssistantInvocation = {
      intent: 'ask',
      items: [],
      draftText: 'custom prompt',
    };
    expect(buildDraft(inv).draftText).to.equal('custom prompt');
  });
});
