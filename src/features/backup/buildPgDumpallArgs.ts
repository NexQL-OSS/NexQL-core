import type { PgDumpallFormState } from './types';
import { assertSafeCliIdentifier } from './identifierSafe';

export function buildPgDumpallArgv(opts: PgDumpallFormState): string[] {
  assertSafeCliIdentifier(opts.outputPath, 'output path');

  const argv: string[] = ['pg_dumpall'];
  if (opts.verbose) {
    argv.push('-v');
  }
  if (opts.globalsOnly) {
    argv.push('-g');
  }
  if (opts.rolesOnly) {
    argv.push('-r');
  }
  if (opts.extraArgv?.length) {
    for (const t of opts.extraArgv) {
      argv.push(t);
    }
  }
  argv.push('-f', opts.outputPath);
  return argv;
}
