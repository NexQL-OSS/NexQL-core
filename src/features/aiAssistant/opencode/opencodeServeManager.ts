import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as net from 'net';
import * as vscode from 'vscode';
import { buildOpencodeHeadlessEnv } from './opencodeHeadlessEnv';
import { appendOpencodeLog } from './opencodeLog';
import { resolveOpencodeCli } from './resolveOpencodeCli';
import { resolveOpencodeWorkingDirectory } from './resolveOpencodeWorkingDirectory';

const OPENCODE_CLIENT_ID = 'nexql';
const MANAGED_SERVE_GLOBAL_KEY = 'postgresExplorer.opencodeManagedServeUrl';
const SERVE_START_TIMEOUT_MS = 45_000;
const HEALTH_POLL_MS = 250;
const DEFAULT_SERVE_HOST = '127.0.0.1';

export class OpencodeServeManager {
  private static instance: OpencodeServeManager | undefined;

  private extensionContext: vscode.ExtensionContext | undefined;
  private proc: ChildProcessWithoutNullStreams | undefined;
  private serveUrl: string | undefined;
  private serveWorkDir: string | undefined;
  private startPromise: Promise<string | undefined> | undefined;

  init(context: vscode.ExtensionContext): void {
    this.extensionContext = context;
  }

  static getInstance(): OpencodeServeManager {
    if (!OpencodeServeManager.instance) {
      OpencodeServeManager.instance = new OpencodeServeManager();
    }
    return OpencodeServeManager.instance;
  }

  static resetInstanceForTests(): void {
    OpencodeServeManager.instance?.dispose();
    OpencodeServeManager.instance = undefined;
  }

  getActiveUrl(): string | undefined {
    return this.serveUrl;
  }

  async ensureServeUrl(config: vscode.WorkspaceConfiguration): Promise<string | undefined> {
    const autoServe = config.get<boolean>('opencodeAutoServe') !== false;
    const manualUrl = config.get<string>('opencodeServeUrl')?.trim();

    if (!autoServe) {
      if (manualUrl && (await isHealthy(manualUrl))) {
        return manualUrl;
      }
      return manualUrl || undefined;
    }

    const workDir = resolveOpencodeWorkingDirectory(config);

    // When auto-serve is on, prefer our managed process (with headless permissions).
    if (this.proc && this.serveUrl && this.serveWorkDir === workDir && (await isHealthy(this.serveUrl))) {
      return this.serveUrl;
    }

    if (this.proc && this.serveWorkDir !== workDir) {
      appendOpencodeLog(`Restarting OpenCode server — workdir changed to ${workDir}`);
      this.dispose();
    }

    if (!autoServe && manualUrl && (await isHealthy(manualUrl))) {
      appendOpencodeLog(`Using configured server ${manualUrl}`);
      return manualUrl;
    }

    if (!this.startPromise) {
      this.startPromise = this.startManagedServer(config).finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  dispose(): void {
    if (this.proc) {
      appendOpencodeLog('Stopping managed OpenCode server…');
      this.proc.kill('SIGTERM');
      this.proc = undefined;
    }
    this.serveUrl = undefined;
    this.serveWorkDir = undefined;
    this.startPromise = undefined;
  }

  private async startManagedServer(
    config: vscode.WorkspaceConfiguration,
  ): Promise<string | undefined> {
    const cli = await resolveOpencodeCli(config);
    if (!cli) {
      appendOpencodeLog('OpenCode CLI not found; cannot auto-start server.', 'stderr');
      return undefined;
    }

    const host = DEFAULT_SERVE_HOST;
    const configuredPort = config.get<number>('opencodeServePort');
    const port =
      typeof configuredPort === 'number' && configuredPort > 0
        ? configuredPort
        : await findFreePort(host);
    const url = `http://${host}:${port}`;

    appendOpencodeLog(`Starting OpenCode server at ${url}…`);

    const env = {
      ...buildOpencodeHeadlessEnv(config),
      OPENCODE_CLIENT: OPENCODE_CLIENT_ID,
    };
    const workDir = resolveOpencodeWorkingDirectory(config);
    this.serveWorkDir = workDir;
    appendOpencodeLog(`Starting serve with headless permissions (YOLO / auto-allow), cwd: ${workDir}`);
    const proc = spawn(cli.command, ['serve', '--hostname', host, '--port', String(port)], {
      shell: false,
      windowsHide: true,
      cwd: workDir,
      env,
    });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => appendOpencodeLog(chunk, 'stdout'));
    proc.stderr.on('data', (chunk: string) => appendOpencodeLog(chunk, 'stderr'));
    proc.on('error', (err) => {
      appendOpencodeLog(`OpenCode server process error: ${err.message}`, 'stderr');
    });
    proc.on('close', (code) => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.serveUrl = undefined;
      }
      appendOpencodeLog(`OpenCode server exited (code ${code ?? 'unknown'})`);
    });

    const ready = await waitForHealthy(url, SERVE_START_TIMEOUT_MS);
    if (!ready) {
      proc.kill('SIGTERM');
      this.proc = undefined;
      throw new Error(`OpenCode server did not become healthy within ${SERVE_START_TIMEOUT_MS}ms.`);
    }

    this.serveUrl = url;
    appendOpencodeLog(`OpenCode server ready at ${url}`);

    if (this.extensionContext) {
      await this.extensionContext.globalState.update(MANAGED_SERVE_GLOBAL_KEY, url);
    }

    if (!manualUrlFromConfig(config)) {
      await config.update('opencodeServeUrl', url, vscode.ConfigurationTarget.Global);
      appendOpencodeLog(`Saved server URL to postgresExplorer.opencodeServeUrl`);
    }

    return url;
  }
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/global/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { healthy?: boolean };
    return body.healthy === true;
  } catch {
    return false;
  }
}

function manualUrlFromConfig(config: vscode.WorkspaceConfiguration): string {
  return config.get<string>('opencodeServeUrl')?.trim() || '';
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isHealthy(url)) {
      return true;
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!port) {
          reject(new Error('Failed to allocate a free port for OpenCode serve.'));
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
