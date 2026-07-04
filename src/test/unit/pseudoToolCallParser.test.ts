import { expect } from 'chai';
import { extractPseudoToolCalls } from '../../providers/chat/tools/pseudoToolCallParser';
import { DB_TOOLS } from '../../providers/chat/tools/ToolSpec';

describe('extractPseudoToolCalls', () => {
  it('recovers a bare call with a hallucinated kwarg the schema does not define', () => {
    const text = "I'll search for tables in the database schema.\n\nsearch_schema('', type_filter='table')";
    const { calls, cleanedText } = extractPseudoToolCalls(text, DB_TOOLS);

    expect(calls).to.have.length(1);
    expect(calls[0].name).to.equal('search_schema');
    expect(calls[0].arguments).to.deep.equal({ query: '' });
    expect(cleanedText).to.equal("I'll search for tables in the database schema.");
  });

  it('recovers a call inside a ```tool_code fenced block', () => {
    const text =
      "I'll search for tables in the database schema.\n\n```tool_code\nsearch_schema('', type_filter='table')\n```";
    const { calls, cleanedText } = extractPseudoToolCalls(text, DB_TOOLS);

    expect(calls).to.have.length(1);
    expect(calls[0].name).to.equal('search_schema');
    expect(calls[0].arguments).to.deep.equal({ query: '' });
    expect(cleanedText).to.equal("I'll search for tables in the database schema.");
  });

  it('maps positional args in declared property order for a multi-arg tool', () => {
    const text = "get_join_path('public.a', 'public.b')";
    const { calls } = extractPseudoToolCalls(text, DB_TOOLS);

    expect(calls).to.have.length(1);
    expect(calls[0].name).to.equal('get_join_path');
    expect(calls[0].arguments).to.deep.equal({ a: 'public.a', b: 'public.b' });
  });

  it('resolves a kwarg-only call regardless of order', () => {
    const text = "get_join_path(b='public.b', a='public.a')";
    const { calls } = extractPseudoToolCalls(text, DB_TOOLS);

    expect(calls).to.have.length(1);
    expect(calls[0].arguments).to.deep.equal({ a: 'public.a', b: 'public.b' });
  });

  it('leaves text untouched when the called name is not a known tool', () => {
    const text = "print('hello world')";
    const { calls, cleanedText } = extractPseudoToolCalls(text, DB_TOOLS);

    expect(calls).to.have.length(0);
    expect(cleanedText).to.equal(text);
  });

  it('leaves plain prose untouched (no false match)', () => {
    const text = 'Here are the tables in your database: users, orders, products.';
    const { calls, cleanedText } = extractPseudoToolCalls(text, DB_TOOLS);

    expect(calls).to.have.length(0);
    expect(cleanedText).to.equal(text);
  });

  it('recovers multiple pseudo calls from separate fenced blocks', () => {
    const text =
      "First:\n\n```tool_code\nsearch_schema('users')\n```\n\nThen:\n\n```tool_code\ndescribe_object('public.users')\n```";
    const { calls, cleanedText } = extractPseudoToolCalls(text, DB_TOOLS);

    expect(calls).to.have.length(2);
    expect(calls[0]).to.deep.equal({ id: 'pseudo_call_0', name: 'search_schema', arguments: { query: 'users' } });
    expect(calls[1]).to.deep.equal({
      id: 'pseudo_call_1',
      name: 'describe_object',
      arguments: { ref: 'public.users' }
    });
    expect(cleanedText).to.equal('First:\n\nThen:');
  });
});
