import * as vscode from 'vscode';

export const PGSTUDIO_SQL_AGENT_ID = 'pgstudio-sql';

/** Inline OpenCode config for headless PgStudio SQL assistance. */
export function buildPgStudioInlineConfig(): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      '*': 'allow',
      external_directory: { '*': 'allow' },
      doom_loop: 'allow',
      question: 'allow',
    },
    agent: {
      [PGSTUDIO_SQL_AGENT_ID]: {
        description: 'NexQL PostgreSQL SQL assistant (text-only, no tools)',
        mode: 'primary',
        permission: {
          bash: 'deny',
          edit: 'deny',
          write: 'deny',
          patch: 'deny',
          task: 'deny',
          webfetch: 'deny',
          websearch: 'deny',
          skill: 'deny',
          lsp: 'deny',
          glob: 'deny',
          grep: 'deny',
          read: 'deny',
          question: 'deny',
          '*': 'allow',
        },
      },
    },
  };
}

/**
 * Env vars for non-interactive OpenCode (serve + run).
 * `--dangerously-skip-permissions` on `run` does not apply when attaching to serve;
 * the server process must inherit these.
 */
export function buildOpencodeHeadlessEnv(
  config: vscode.WorkspaceConfiguration,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const skipPermissions = config.get<boolean>('opencodeSkipPermissions') !== false;

  if (skipPermissions) {
    env.OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS = 'true';
    env.OPENCODE_YOLO = 'true';
    env.OPENCODE_PERMISSION = JSON.stringify({
      '*': 'allow',
      external_directory: { '*': 'allow' },
      doom_loop: 'allow',
      question: 'allow',
    });
  }

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildPgStudioInlineConfig());
  return env;
}
