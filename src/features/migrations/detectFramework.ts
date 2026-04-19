import * as fs from 'fs';
import * as path from 'path';

/**
 * Best-effort detection of migration tool layout (v1.3+). Returns null when unknown.
 */
export function detectMigrationFramework(workspaceRoot: string): string | null {
  const candidates = [
    ['migrations'],
    ['db', 'migrations'],
    ['prisma', 'migrations'],
  ];
  for (const parts of candidates) {
    const p = path.join(workspaceRoot, ...parts);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return parts.join('/');
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}
