import { expect } from 'chai';
import * as http from 'http';
import { AddressInfo } from 'net';
import { AiService } from '../../providers/chat/AiService';

/**
 * Regression coverage for direct-API tool-call response parsing.
 *
 * Before this fix, `_makeHttpRequest`'s non-streaming branch only ever read `.content`
 * out of the provider response — `tool_calls` / `tool_use` blocks were silently dropped,
 * so ToolOrchestrator.run() never saw `response.toolCalls` for any provider except
 * `vscode-lm`. The agentic loop looked like it worked (Pro-gated, wired end to end) but
 * for OpenAI/Anthropic/Gemini/nexql-free/custom it never actually called a tool.
 */
describe('AiService._makeHttpRequest tool-call extraction', () => {
  let server: http.Server;
  let endpoint: string;
  let nextResponse: unknown;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextResponse));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('extracts OpenAI-compatible tool_calls with parsed JSON arguments', async () => {
    nextResponse = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'search_schema', arguments: '{"query":"users"}' } },
            ],
          },
        },
      ],
      usage: { total_tokens: 10, prompt_tokens: 6, completion_tokens: 4 },
    };

    const service = new AiService();
    const result = await (service as any)._makeHttpRequest(endpoint, {}, { messages: [] }, 'openai');

    expect(result.toolCalls).to.have.length(1);
    expect(result.toolCalls[0]).to.deep.equal({ id: 'call_1', name: 'search_schema', arguments: { query: 'users' } });
  });

  it('falls back to a raw-string argument when tool_call arguments are not valid JSON', async () => {
    nextResponse = {
      choices: [
        { message: { tool_calls: [{ id: 'call_2', function: { name: 'run_select', arguments: 'not json' } }] } },
      ],
    };

    const service = new AiService();
    const result = await (service as any)._makeHttpRequest(endpoint, {}, { messages: [] }, 'openai');

    expect(result.toolCalls[0].arguments).to.deep.equal({ raw: 'not json' });
  });

  it('extracts Anthropic tool_use blocks (arguments already parsed)', async () => {
    nextResponse = {
      content: [
        { type: 'text', text: 'Let me check that.' },
        { type: 'tool_use', id: 'toolu_1', name: 'describe_object', input: { ref: 'public.users' } },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    };

    const service = new AiService();
    const result = await (service as any)._makeHttpRequest(endpoint, {}, { messages: [] }, 'anthropic');

    expect(result.text).to.equal('Let me check that.');
    expect(result.toolCalls).to.deep.equal([{ id: 'toolu_1', name: 'describe_object', arguments: { ref: 'public.users' } }]);
  });

  it('extracts Gemini functionCall parts with a synthetic id', async () => {
    nextResponse = {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'sample_values', args: { ref: 'public.users', col: 'status' } } }] } },
      ],
    };

    const service = new AiService();
    const result = await (service as any)._makeHttpRequest(endpoint, {}, { messages: [] }, 'gemini');

    expect(result.toolCalls).to.deep.equal([
      { id: 'gemini_call_0', name: 'sample_values', arguments: { ref: 'public.users', col: 'status' } },
    ]);
  });

  it('returns no toolCalls for a plain text response', async () => {
    nextResponse = { choices: [{ message: { content: 'just text' } }] };

    const service = new AiService();
    const result = await (service as any)._makeHttpRequest(endpoint, {}, { messages: [] }, 'openai');

    expect(result.text).to.equal('just text');
    expect(result.toolCalls).to.be.undefined;
  });
});
