import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const IDE_INSTALL_PATTERNS = [
  /[/\\]Microsoft VS Code[/\\]?/i,
  /[/\\]Cursor[/\\]?/i,
  /[/\\]Programs[/\\]Microsoft VS Code/i,
  /[/\\]AppData[/\\]Local[/\\]Programs[/\\]/i,
  /[/\\]\.cursor[/\\]extensions[/\\]/i,
  /[/\\]node_modules[/\\]@vscode[/\\]/i,
];

const NEXQL_OPENCODE_DIR = path.join(os.homedir(), '.nexql', 'opencode-wd');

function isIdeInstallPath(dirPath: string): boolean {
  const normalized = path.normalize(dirPath);
  return IDE_INSTALL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isUsableDirectory(dirPath: string): boolean {
  try {
    const stat = fs.statSync(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function ensureDirectory(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Working directory for OpenCode serve/run. Avoids VS Code/Cursor install paths
 * (common when no workspace is open in the Extension Development Host).
 */
export function resolveOpencodeWorkingDirectory(
  config?: vscode.WorkspaceConfiguration,
): string {
  const configured = config?.get<string>('opencodeWorkingDirectory')?.trim();
  if (configured && isUsableDirectory(configured) && !isIdeInstallPath(configured)) {
    return path.normalize(configured);
  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    for (const folder of folders) {
      const candidate = folder.uri.fsPath;
      if (isUsableDirectory(candidate) && !isIdeInstallPath(candidate)) {
        return path.normalize(candidate);
      }
    }
  }

  const cwd = process.cwd();
  if (isUsableDirectory(cwd) && !isIdeInstallPath(cwd)) {
    return path.normalize(cwd);
  }

  return ensureDirectory(NEXQL_OPENCODE_DIR);
}
