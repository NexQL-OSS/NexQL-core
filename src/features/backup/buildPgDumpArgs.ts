import type { PgDumpFormState } from './types';
import { assertSafeCliIdentifier, assertSafePgDumpTableArg, assertSafeTableQualified } from './identifierSafe';

/** Builds pg_dump argv (program name first). Connection host/port/user passed separately by runner. */
export function buildPgDumpArgv(opts: PgDumpFormState): string[] {
  assertSafeCliIdentifier(opts.database, 'database');
  if (opts.outputPath) {
    assertSafeCliIdentifier(opts.outputPath, 'outputPath');
  }
  const hasSchemaList = opts.schemaNameList && opts.schemaNameList.length > 0;
  if (hasSchemaList) {
    for (const s of opts.schemaNameList!) {
      assertSafeCliIdentifier(s, 'schema');
    }
  } else if (opts.schemaName) {
    assertSafeCliIdentifier(opts.schemaName, 'schema');
  }

  const hasTableList = opts.tableQualifiedList && opts.tableQualifiedList.length > 0;
  if (opts.tableQualified && !hasTableList) {
    assertSafeTableQualified(opts.tableQualified);
  }
  if (hasTableList) {
    for (const t of opts.tableQualifiedList!) {
      assertSafePgDumpTableArg(t);
    }
  }

  const argv: string[] = ['pg_dump'];

  argv.push('-F', opts.format);
  if (opts.verbose) {
    argv.push('-v');
  }
  if (opts.schemaOnly) {
    argv.push('-s');
  }
  if (opts.dataOnly) {
    argv.push('-a');
  }
  if (opts.blobs) {
    argv.push('-b');
  }

  if (opts.format === 'd' && opts.parallelJobs > 1) {
    argv.push('-j', String(Math.floor(opts.parallelJobs)));
  }

  if (opts.format === 'c' && opts.compression !== null && opts.compression !== undefined) {
    const z = Math.max(0, Math.min(9, Math.floor(opts.compression)));
    argv.push('-Z', String(z));
  }

  argv.push('-f', opts.outputPath);

  if (hasTableList) {
    for (const t of opts.tableQualifiedList!) {
      argv.push('-t', t);
    }
  } else if (opts.tableQualified) {
    argv.push('-t', opts.tableQualified);
  }
  if (!hasTableList && !opts.tableQualified) {
    if (hasSchemaList) {
      for (const s of opts.schemaNameList!) {
        argv.push('-n', s);
      }
    } else if (opts.schemaName) {
      argv.push('-n', opts.schemaName);
    }
  }

  if (opts.extraArgv?.length) {
    for (const t of opts.extraArgv) {
      argv.push(t);
    }
  }

  argv.push(opts.database);
  return argv;
}
