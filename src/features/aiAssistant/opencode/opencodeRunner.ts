import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';
import { buildOpencodeHeadlessEnv } from './opencodeHeadlessEnv';
import {
  appendOpencodeLog,
  showOpencodeLog,
  summarizeOpencodeJsonLine,
} from './opencodeLog';
import { OpencodePermissionBridge } from './opencodePermissionBridge';
import { OpencodeServeManager } from './opencodeServeManager';
import { runViaServeHttp } from './opencodeServeHttp';
import { resolveOpencodeCli } from './resolveOpencodeCli';
import { resolveOpencodeWorkingDirectory } from './resolveOpencodeWorkingDirectory';

const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const OPENCODE_CLIENT_ID = 'nexql';

export interface OpencodeRunOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  serveUrl?: string;
  cancellationToken?: vscode.CancellationToken;
  timeoutMs?: number;
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
  showLog?: boolean;
}

export interface OpencodeRunResult {
  text: string;
  usage?: string;
  transport: 'cli' | 'sdk';
}

function splitProviderModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash >= model.length - 1) {
    return undefined;
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

function extractTextFromJsonEvent(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return '';
  }
  const record = event as Record<string, unknown>;

  if (typeof record.text === 'string') {
    return record.text;
  }

  const part = record.part as Record<string, unknown> | undefined;
  if (part?.type === 'text' && typeof part.text === 'string') {
    return part.text;
  }

  const parts = record.parts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: Record<string, unknown>) => p.type === 'text' && typeof p.text === 'string')
      .map((p: Record<string, unknown>) => p.text as string)
      .join('');
  }

  return '';
}

function parseJsonRunOutput(stdout: string): string {
  const chunks: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const text = extractTextFromJsonEvent(JSON.parse(trimmed));
      if (text) {
        chunks.push(text);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return chunks.join('\n').trim();
}

function emitLogLine(
  chunk: string,
  stream: 'stdout' | 'stderr',
  onLog: OpencodeRunOptions['onLog'],
  lineBuffer: { value: string },
): void {
  lineBuffer.value += chunk;
  const lines = lineBuffer.value.split('\n');
  lineBuffer.value = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const summary = summarizeOpencodeJsonLine(trimmed);
    const message = summary || trimmed;
    appendOpencodeLog(message, stream);
    onLog?.(message, stream);
  }
}

async function runViaCli(
  command: string,
  config: vscode.WorkspaceConfiguration,
  options: OpencodeRunOptions,
): Promise<OpencodeRunResult> {
  const args = [
    'run',
    '--format',
    'json',
    '--print-logs',
    '--log-level',
    'INFO',
    '--dangerously-skip-permissions',
  ];
  const workDir = options.cwd || resolveOpencodeWorkingDirectory(config);

  if (options.model) {
    args.push('-m', options.model);
  }
  args.push(options.prompt);

  appendOpencodeLog(
    `Running: ${command} ${args.slice(0, -1).join(' ')} "<prompt ${options.prompt.length} chars>"`,
  );
  appendOpencodeLog(`Working directory: ${workDir}`);
  if (options.model) {
    appendOpencodeLog(`Model: ${options.model}`);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  return await new Promise<OpencodeRunResult>((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams | undefined;
    let stdout = '';
    let stderr = '';
    const stdoutBuffer = { value: '' };
    const stderrBuffer = { value: '' };
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancellationRegistration?.dispose();
      fn();
    };

    const env = {
      ...buildOpencodeHeadlessEnv(config),
      OPENCODE_CLIENT: OPENCODE_CLIENT_ID,
    };

    proc = spawn(command, args, {
      shell: false,
      windowsHide: true,
      cwd: workDir,
      env,
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      emitLogLine(chunk, 'stdout', options.onLog, stdoutBuffer);
    });
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      emitLogLine(chunk, 'stderr', options.onLog, stderrBuffer);
    });

    const cancellationRegistration = options.cancellationToken?.onCancellationRequested(() => {
      proc?.kill('SIGTERM');
      finish(() => reject(new Error('AI request cancelled.')));
    });

    const timer = setTimeout(() => {
      proc?.kill('SIGTERM');
      finish(() => reject(new Error(`OpenCode CLI timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    proc.on('error', (err) => {
      finish(() => reject(new Error(`Failed to run OpenCode CLI: ${err.message}`)));
    });

    proc.on('close', (code) => {
      if (settled) {
        return;
      }
      appendOpencodeLog(`OpenCode run exited (code ${code ?? 'unknown'}, stdout ${stdout.length} bytes)`);
      const parsed = parseJsonRunOutput(stdout);
      const text = parsed || stdout.trim();
      if (code !== 0 && !text) {
        const detail = (stderr || stdout).trim();
        finish(() =>
          reject(
            new Error(
              detail
                ? `OpenCode CLI exited with code ${code}: ${detail}`
                : `OpenCode CLI exited with code ${code}.`,
            ),
          ),
        );
        return;
      }
      if (!text) {
        finish(() => reject(new Error('OpenCode returned an empty response.')));
        return;
      }
      finish(() => resolve({ text, transport: 'cli' }));
    });
  });
}

async function loadOpencodeSdk(): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import('@opencode-ai/sdk')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function runViaSdk(options: OpencodeRunOptions): Promise<OpencodeRunResult> {
  const sdk = await loadOpencodeSdk();
  if (!sdk?.createOpencode) {
    throw new Error('OpenCode SDK (@opencode-ai/sdk) is not installed.');
  }

  const modelParts = options.model ? splitProviderModel(options.model) : undefined;
  const createOpencode = sdk.createOpencode as (opts: {
    timeout: number;
    config: Record<string, string>;
  }) => Promise<{ client: any; server: { close: () => void } }>;
  const opencode = await createOpencode({
    timeout: 15_000,
    config: options.model ? { model: options.model } : {},
  });

  try {
    const created = await opencode.client.session.create({
      body: { title: 'NexQL SQL Assistant' },
    });
    const sessionId = created.data?.id;
    if (!sessionId) {
      throw new Error('OpenCode SDK failed to create a session.');
    }

    const promptBody: {
      parts: Array<{ type: 'text'; text: string }>;
      model?: { providerID: string; modelID: string };
    } = {
      parts: [{ type: 'text', text: options.prompt }],
    };
    if (modelParts) {
      promptBody.model = modelParts;
    }

    const result = await opencode.client.session.prompt({
      path: { id: sessionId },
      body: promptBody,
    });

    const parts = (result.data?.parts || []) as Array<Record<string, unknown>>;
    const text = parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
      .trim();

    if (!text) {
      throw new Error('OpenCode SDK returned an empty response.');
    }

    return { text, transport: 'sdk' };
  } finally {
    opencode.server.close();
  }
}

/**
 * Run a single-shot OpenCode prompt. Prefers the detected CLI (user auth); falls back to SDK.
 */
export async function runOpencodePrompt(
  config: vscode.WorkspaceConfiguration,
  options: OpencodeRunOptions,
): Promise<OpencodeRunResult> {
  const showLog = options.showLog !== false && config.get<boolean>('opencodeShowLog') !== false;
  if (showLog) {
    showOpencodeLog(false);
  }

  let serveUrl = options.serveUrl?.trim();
  if (!serveUrl && config.get<boolean>('opencodeAutoServe') !== false) {
    serveUrl = (await OpencodeServeManager.getInstance().ensureServeUrl(config)) || undefined;
  }
  const resolvedOptions = { ...options, serveUrl };

  const permissionBridge = new OpencodePermissionBridge();
  if (serveUrl && config.get<boolean>('opencodeAutoApprovePermissions') !== false) {
    permissionBridge.start(serveUrl);
  }

  try {
    if (serveUrl) {
      try {
        return await runViaServeHttp(serveUrl, config, resolvedOptions);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendOpencodeLog(`HTTP serve prompt failed, falling back to CLI: ${message}`, 'stderr');
      }
    }

    const cli = await resolveOpencodeCli(config);
    if (cli) {
      const result = await runViaCli(cli.command, config, resolvedOptions);
      return { ...result, usage: `OpenCode CLI ${cli.version}` };
    }

    if (config.get<boolean>('opencodePreferSdk') === true) {
      const result = await runViaSdk(resolvedOptions);
      return { ...result, usage: 'OpenCode SDK' };
    }

    throw new Error(
      'OpenCode CLI not found. Install from https://opencode.ai or set postgresExplorer.opencodeCliPath.',
    );
  } finally {
    permissionBridge.stop();
  }
}

export async function listOpencodeModels(
  config: vscode.WorkspaceConfiguration,
): Promise<string[]> {
  const cli = await resolveOpencodeCli(config);
  if (!cli) {
    throw new Error(
      'OpenCode CLI not found. Install from https://opencode.ai or set postgresExplorer.opencodeCliPath.',
    );
  }

  return await new Promise<string[]>((resolve, reject) => {
    const proc = spawn(cli.command, ['models'], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, OPENCODE_CLIENT: OPENCODE_CLIENT_ID },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    proc.on('error', (err) => reject(new Error(`Failed to list OpenCode models: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `opencode models exited with code ${code}`));
        return;
      }
      const models = stdout
        .split('\n')
        .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
        .filter((line) => line.includes('/'));
      resolve(models);
    });
  });
}

export async function testOpencodeConnection(
  config: vscode.WorkspaceConfiguration,
  model?: string,
): Promise<string> {
  const cli = await resolveOpencodeCli(config);
  if (!cli) {
    throw new Error(
      'OpenCode CLI not found. Install from https://opencode.ai or set postgresExplorer.opencodeCliPath.',
    );
  }

  let serveNote = '';
  if (config.get<boolean>('opencodeAutoServe') !== false) {
    const serveUrl = await OpencodeServeManager.getInstance().ensureServeUrl(config);
    serveNote = serveUrl ? ` Server: ${serveUrl}.` : '';
  }

  const models = await listOpencodeModels(config);
  const resolvedModel = model?.trim() || models[0];
  if (!resolvedModel) {
    throw new Error(
      'No OpenCode models available. Run `opencode auth login` to configure a provider.',
    );
  }
  if (model && model !== 'auto' && !models.includes(model)) {
    throw new Error(
      `Configured OpenCode model "${model}" not found. Example models: ${models.slice(0, 5).join(', ')}`,
    );
  }

  return `OpenCode CLI ${cli.version} detected.${serveNote} ${models.length} model(s) available${resolvedModel ? `; default: ${resolvedModel}` : ''}.`;
}
