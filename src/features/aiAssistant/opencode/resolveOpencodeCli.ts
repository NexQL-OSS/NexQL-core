import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

const OPENCODE_CLI_NAMES = ['opencode', 'opencode-ai'] as const;

export interface ResolvedOpencodeCli {
  command: string;
  version: string;
}

function configuredCliPath(config: vscode.WorkspaceConfiguration): string | undefined {
  const fromConfig = config.get<string>('opencodeCliPath')?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = process.env.OPENCODE_BIN?.trim() || process.env.OPENCODE_INSTALL_DIR?.trim();
  if (fromEnv) {
    return fromEnv.includes(path.sep) ? fromEnv : path.join(fromEnv, 'opencode');
  }
  return undefined;
}

function defaultInstallCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    path.join(home, 'bin', 'opencode'),
  ];
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function probeVersion(command: string): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const proc = spawn(command, ['--version'], {
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      out += chunk;
    });
    proc.on('error', () => resolve(undefined));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      const version = out.trim().split(/\s+/)[0] || out.trim();
      resolve(version || undefined);
    });
  });
}

/**
 * Resolve the OpenCode CLI on the user's machine (PATH, install script locations, or setting).
 */
export async function resolveOpencodeCli(
  config: vscode.WorkspaceConfiguration,
): Promise<ResolvedOpencodeCli | undefined> {
  const candidates: string[] = [];
  const configured = configuredCliPath(config);
  if (configured) {
    candidates.push(configured);
  }
  for (const name of OPENCODE_CLI_NAMES) {
    candidates.push(name);
  }
  candidates.push(...defaultInstallCandidates());

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (normalized.includes(path.sep) && !isExecutableFile(normalized)) {
      continue;
    }

    const version = await probeVersion(normalized);
    if (version) {
      return { command: normalized, version };
    }
  }

  return undefined;
}
