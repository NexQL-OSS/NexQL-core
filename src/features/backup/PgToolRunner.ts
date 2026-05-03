import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';

export interface RunPgToolOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  token?: vscode.CancellationToken;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunPgToolResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Runs a PostgreSQL CLI tool with streamed stdout/stderr. Uses argv array (no shell).
 */
export async function runPgTool(options: RunPgToolOptions): Promise<RunPgToolResult> {
  const [command, ...args] = options.argv;
  if (!command) {
    throw new Error('Missing command');
  }

  return await new Promise<RunPgToolResult>((resolve, reject) => {
    const proc: ChildProcessWithoutNullStreams = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      shell: false,
      windowsHide: true
    });

    let cancelled = false;

    const killProc = () => {
      if (!proc.killed && proc.pid) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    };

    const sub = options.token?.onCancellationRequested(() => {
      cancelled = true;
      killProc();
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (data: string) => {
      options.onStdout?.(data);
    });
    proc.stderr.on('data', (data: string) => {
      options.onStderr?.(data);
    });

    proc.on('error', err => {
      sub?.dispose();
      reject(err);
    });

    proc.on('close', (code, signal) => {
      sub?.dispose();
      if (cancelled) {
        resolve({ exitCode: code, signal });
        return;
      }
      resolve({ exitCode: code, signal });
    });
  });
}
