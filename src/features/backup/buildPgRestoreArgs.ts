import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PgRestoreFormState } from './types';
import { assertSafeCliIdentifier } from './identifierSafe';

export interface PgRestoreArgvResult {
  argv: string[];
  /** Temp file to unlink after spawn exits (list file) */
  tempFiles: string[];
}

export function buildPgRestoreArgv(opts: PgRestoreFormState): PgRestoreArgvResult {
  assertSafeCliIdentifier(opts.targetDatabase, 'target database');
  assertSafeCliIdentifier(opts.inputPath, 'input path');

  const argv: string[] = ['pg_restore'];
  const tempFiles: string[] = [];

  if (opts.verbose) {
    argv.push('-v');
  }
  if (opts.jobs > 1) {
    argv.push('-j', String(Math.floor(opts.jobs)));
  }

  if (opts.extraArgv?.length) {
    for (const t of opts.extraArgv) {
      argv.push(t);
    }
  }

  argv.push('-d', opts.targetDatabase);

  if (opts.selectedListLines && opts.selectedListLines.length > 0) {
    const body = opts.selectedListLines.join('\n') + '\n';
    const tmp = path.join(os.tmpdir(), `pgstudio-restore-list-${Date.now()}-${Math.random().toString(36).slice(2)}.lst`);
    fs.writeFileSync(tmp, body, 'utf8');
    tempFiles.push(tmp);
    argv.push('-L', tmp);
  }

  argv.push(opts.inputPath);
  return { argv, tempFiles };
}

/** argv for pg_restore --list (dry-run catalog); does not use DB connection */
export function buildPgRestoreListArgv(archivePath: string, extraArgv?: string[]): string[] {
  assertSafeCliIdentifier(archivePath, 'archive path');
  return ['pg_restore', ...(extraArgv ?? []), '--list', archivePath];
}
