import * as vscode from 'vscode';
import { IndexScope, ObjectEntry } from './types';

// Regex patterns to detect PII names
const PII_NAME_REGEX = /email|ssn|phone|password|token|secret|address|card|credit|auth|login|dob|zip|identity/i;

// Regex patterns to detect PII values (for redacting/excluding sampled values)
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const SSN_REGEX = /^\d{3}-\d{2}-\d{4}$/;

/**
 * Profiles the tables using pg_stats. Does not execute any tables scans (safe on PROD).
 * Checks column names and actual values to redact PII data.
 */
export async function runValueProfiling(
  client: any,
  entriesMap: Record<string, ObjectEntry>,
  scope: IndexScope,
  warnings: string[],
  cancellationToken?: vscode.CancellationToken
): Promise<number> {
  const schemas = scope.includedSchemas.length > 0 ? scope.includedSchemas : ['public'];
  let queriesRun = 0;

  try {
    const statsResult = await client.query(`
      SELECT
        schemaname,
        tablename,
        attname,
        null_frac::float AS null_frac,
        n_distinct::float AS n_distinct,
        most_common_vals::text AS most_common_vals
      FROM pg_stats
      WHERE schemaname = ANY($1)
    `, [schemas]);
    queriesRun++;

    const rows = statsResult.rows;
    for (const row of rows) {
      if (cancellationToken?.isCancellationRequested) {
        break;
      }

      const refTable = `${row.schemaname}.${row.tablename}`;
      const refColumn = `${refTable}.${row.attname}`;

      const entry = entriesMap[refTable];
      if (!entry) {
        continue;
      }

      const col = entry.columns.find(c => c.name === row.attname);
      if (!col) {
        continue;
      }

      // Check PII exclusions (configured or name-based heuristics)
      if (
        scope.piiExcludedColumns.includes(refColumn) ||
        PII_NAME_REGEX.test(row.attname)
      ) {
        continue;
      }

      // Parse pg_stats most_common_vals safely
      let commonValues: string[] | undefined;
      if (row.most_common_vals) {
        try {
          // most_common_vals format: {val1,val2,val3} or {"value with spaces","val2"}
          const rawVals = row.most_common_vals.replace(/^\{/, '').replace(/\}$/, '');
          if (rawVals) {
            commonValues = rawVals.split(',')
              .map((v: string) => v.trim().replace(/^"|"$/g, ''))
              .filter((v: string) => v.length > 0 && v.length <= 64)
              // Second-layer defense: verify item content is not PII
              .map((v: string) => {
                if (EMAIL_REGEX.test(v) || SSN_REGEX.test(v)) {
                  return '[REDACTED PII]';
                }
                return v;
              })
              .slice(0, 10);
          }
        } catch {
          // Parse failures default to no common values listed
        }
      }

      col.profile = {
        nullFrac: parseFloat(row.null_frac) || 0,
        nDistinct: parseFloat(row.n_distinct) || 0,
        commonValues,
      };
    }
  } catch (err: any) {
    warnings.push(`Profiling values from pg_stats failed: ${err.message || err}`);
  }

  return queriesRun;
}
