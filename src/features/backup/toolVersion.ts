import { spawn } from 'child_process';

export interface ToolVersionInfo {
  /** Major version number from --version output, e.g. 16 */
  major: number;
  raw: string;
}

function parseMajorFromVersionOutput(text: string): number {
  const m = /(\d+)\.(\d+)/.exec(text);
  if (m) {
    return parseInt(m[1]!, 10);
  }
  return 0;
}

async function runVersionFlag(tool: 'pg_dump' | 'pg_restore'): Promise<ToolVersionInfo> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(tool, ['--version'], { shell: false, windowsHide: true });
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => {
      out += d;
    });
    proc.stderr.on('data', (d: string) => {
      out += d;
    });
    proc.on('error', reject);
    proc.on('close', () => {
      const raw = out.trim();
      resolve({ major: parseMajorFromVersionOutput(raw), raw });
    });
  });
}

export async function getPgDumpVersion(): Promise<ToolVersionInfo> {
  return await runVersionFlag('pg_dump');
}

export async function getPgRestoreVersion(): Promise<ToolVersionInfo> {
  return await runVersionFlag('pg_restore');
}

/** server_version_num / 10000 → major */
export function serverMajorFromVersionNum(serverVersionNum: number): number {
  return Math.floor(serverVersionNum / 10000);
}

export function isMajorMismatch(toolMajor: number, serverMajor: number): boolean {
  if (toolMajor <= 0 || serverMajor <= 0) {
    return false;
  }
  return toolMajor !== serverMajor;
}
