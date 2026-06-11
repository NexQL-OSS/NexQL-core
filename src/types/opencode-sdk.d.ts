declare module '@opencode-ai/sdk' {
  export function createOpencode(options?: Record<string, unknown>): Promise<{
    client: {
      session: {
        create(args: { body: Record<string, unknown> }): Promise<{ data?: { id?: string } }>;
        prompt(args: {
          path: { id: string };
          body: Record<string, unknown>;
        }): Promise<{ data?: { parts?: Array<Record<string, unknown>> } }>;
      };
    };
    server: { close(): void };
  }>;

  export function createOpencodeClient(options?: Record<string, unknown>): unknown;
}
