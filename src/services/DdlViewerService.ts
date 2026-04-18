import * as vscode from 'vscode';
import { PoolClient } from 'pg';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { ConnectionManager } from './ConnectionManager';
import { createMetadata, getConnectionWithPassword } from '../commands/connection';

const DDL_VIEWER_SCHEME = 'pgstudio-ddl';
const DDL_VIEWER_ENABLED_CONFIG = 'pgstudio.ddlViewer.enabled';

function isDdlViewerEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(DDL_VIEWER_ENABLED_CONFIG, true);
}

type DdlObjectType =
  | 'database'
  | 'schema'
  | 'table'
  | 'partition'
  | 'column'
  | 'view'
  | 'rule'
  | 'function'
  | 'procedure'
  | 'constraint'
  | 'index'
  | 'materialized-view'
  | 'sequence'
  | 'type'
  | 'domain'
  | 'trigger'
  | 'extension'
  | 'role'
  | 'foreign-table'
  | 'foreign-data-wrapper'
  | 'foreign-server'
  | 'policy'
  | 'placeholder';

interface DdlViewerTarget {
  connectionId: string;
  databaseName: string;
  schema?: string;
  objectType: DdlObjectType;
  objectName?: string;
  tableName?: string;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function ensureSemicolon(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function commentBlock(lines: string | string[]): string {
  const content = Array.isArray(lines) ? lines : lines.split(/\r?\n/);
  return ['-- Down operation', ...content.map(line => `-- ${line}`)].join('\n');
}

function appendDownOperation(script: string, downOperation: string | string[]): string {
  return [script.trimEnd(), '', commentBlock(downOperation)].join('\n');
}

function toTitleType(objectType: DdlObjectType): string {
  switch (objectType) {
    case 'database':
      return 'DATABASE';
    case 'schema':
      return 'SCHEMA';
    case 'column':
      return 'COLUMN';
    case 'constraint':
      return 'CONSTRAINT';
    case 'partition':
      return 'TABLE PARTITION';
    case 'materialized-view':
      return 'MATERIALIZED VIEW';
    case 'foreign-table':
      return 'FOREIGN TABLE';
    case 'foreign-data-wrapper':
      return 'FOREIGN DATA WRAPPER';
    case 'foreign-server':
      return 'FOREIGN SERVER';
    case 'domain':
      return 'TYPE (DOMAIN)';
    case 'policy':
      return 'POLICY';
    case 'placeholder':
      return 'INFO';
    default:
      return objectType.toUpperCase();
  }
}

function toObjectDisplayName(target: DdlViewerTarget): string {
  if (!target.objectName) {
    return '(selection)';
  }
  if (target.objectType === 'policy' && target.tableName && target.schema) {
    return `${target.schema}.${target.tableName}.${target.objectName}`;
  }
  if (target.schema) {
    return `${target.schema}.${target.objectName}`;
  }
  return target.objectName;
}

function encodeTarget(target: DdlViewerTarget): string {
  return Buffer.from(JSON.stringify(target), 'utf8').toString('base64');
}

function decodeTarget(uri: vscode.Uri): DdlViewerTarget {
  const params = new URLSearchParams(uri.query);
  const encoded = params.get('data');
  if (!encoded) {
    throw new Error('Invalid DDL viewer URI payload.');
  }
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as DdlViewerTarget;
}

class DdlViewerCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();

  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== DDL_VIEWER_SCHEME) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    const range = new vscode.Range(0, 0, 0, 0);
    const isEnabled = isDdlViewerEnabled();

    codeLenses.push(new vscode.CodeLens(range, {
      title: isEnabled ? 'Disable SQL Preview' : 'Enable SQL Preview',
      command: 'postgres-explorer.ddlViewer.toggleEnabled',
      arguments: [!isEnabled]
    }));

    codeLenses.push(new vscode.CodeLens(range, {
      title: 'Open as Editable Copy',
      command: 'postgres-explorer.ddlViewer.openEditableCopy',
      arguments: [document.uri]
    }));

    codeLenses.push(new vscode.CodeLens(range, {
      title: 'Copy to Clipboard',
      command: 'postgres-explorer.ddlViewer.copyToClipboard',
      arguments: [document.uri]
    }));

    try {
      const target = decodeTarget(document.uri);
      if (target.objectType === 'function' || target.objectType === 'procedure') {
        codeLenses.push(new vscode.CodeLens(range, {
          title: 'Execute',
          command: 'postgres-explorer.ddlViewer.executeRoutine',
          arguments: [document.uri]
        }));
      }
    } catch {
      // Ignore malformed URI and keep baseline actions.
    }

    return codeLenses;
  }
}

class DdlContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  private readonly contentCache = new Map<string, string>();

  public readonly onDidChange = this._onDidChange.event;

  public refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  public refreshAllOpenDdlDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === DDL_VIEWER_SCHEME) {
        this._onDidChange.fire(doc.uri);
      }
    }
  }

  public getCachedContent(uri: vscode.Uri): string | undefined {
    return this.contentCache.get(uri.toString());
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const target = decodeTarget(uri);
      const content = await this.generateContent(target);
      this.contentCache.set(uri.toString(), content);
      return content;
    } catch (err: any) {
      return [
        '-- Connection unavailable. Reconnect to view this definition.',
        `-- Error: ${err?.message || String(err)}`
      ].join('\n');
    }
  }

  private async generateContent(target: DdlViewerTarget): Promise<string> {
    if (target.objectType === 'placeholder') {
      return this.withHeader(
        target,
        '-- Select a table, view, function, or other object to view its definition.'
      );
    }

    let client: PoolClient | undefined;

    try {
      const connection = await getConnectionWithPassword(target.connectionId, target.databaseName);
      client = await ConnectionManager.getInstance().getPooledClient({
        id: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        database: target.databaseName,
        name: connection.name,
        password: connection.password
      });

      let ddl = '';

      switch (target.objectType) {
        case 'database':
          ddl = await this.generateDatabaseDdl(client, target);
          break;
        case 'schema':
          ddl = await this.generateSchemaDdl(client, target);
          break;
        case 'table':
          ddl = await this.generateTableDdl(client, target);
          break;
        case 'partition':
          ddl = await this.generatePartitionDdl(client, target);
          break;
        case 'column':
          ddl = await this.generateColumnDdl(client, target);
          break;
        case 'view':
          ddl = await this.generateViewDdl(client, target);
          break;
        case 'rule':
          ddl = await this.generateRuleDdl(client, target);
          break;
        case 'function':
          ddl = await this.generateRoutineDdl(client, target, 'function');
          break;
        case 'procedure':
          ddl = await this.generateRoutineDdl(client, target, 'procedure');
          break;
        case 'constraint':
          ddl = await this.generateConstraintDdl(client, target);
          break;
        case 'index':
          ddl = await this.generateIndexDdl(client, target);
          break;
        case 'materialized-view':
          ddl = await this.generateMaterializedViewDdl(client, target);
          break;
        case 'sequence':
          ddl = await this.generateSequenceDdl(client, target);
          break;
        case 'type':
          ddl = await this.generateTypeDdl(client, target);
          break;
        case 'domain':
          ddl = await this.generateDomainDdl(client, target);
          break;
        case 'trigger':
          ddl = await this.generateTriggerDdl(client, target);
          break;
        case 'policy':
          ddl = await this.generatePolicyDdl(client, target);
          break;
        case 'extension':
          ddl = await this.generateExtensionDdl(client, target);
          break;
        case 'role':
          ddl = await this.generateRoleDdl(client, target);
          break;
        case 'foreign-table':
          ddl = await this.generateForeignTableDdl(client, target);
          break;
        case 'foreign-server':
          ddl = await this.generateForeignServerDdl(client, target);
          break;
        case 'foreign-data-wrapper':
          ddl = `-- DDL generation for ${toTitleType(target.objectType)} is not yet supported.`;
          break;
      }

      return this.withHeader(target, ddl);
    } catch (err: any) {
      const message = err?.message || String(err);
      const content = message.toLowerCase().includes('permission denied')
        ? `-- Permission denied while reading object definition.\n-- ${message}`
        : `-- Connection unavailable. Reconnect to view this definition.\n-- ${message}`;
      return this.withHeader(target, content);
    } finally {
      try {
        client?.release();
      } catch {
        // Ignore release errors.
      }
    }
  }

  private withHeader(target: DdlViewerTarget, body: string): string {
    const generated = new Date().toISOString();
    const cleanedBody = (body || '').trimEnd();
    const lineCount = cleanedBody ? cleanedBody.split(/\r?\n/).length : 0;

    return [
      `-- Object:    ${toObjectDisplayName(target)}`,
      `-- Type:      ${toTitleType(target.objectType)}`,
      `-- Database:  ${target.databaseName}`,
      `-- Generated: ${generated}`,
      `-- Lines:     ${lineCount}`,
      '',
      cleanedBody || '-- Object not found. The tree may be out of sync - try refreshing.'
    ].join('\n');
  }

  private async generateDatabaseDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT
         d.datname,
         pg_get_userbyid(d.datdba) AS owner,
         pg_encoding_to_char(d.encoding) AS encoding,
         d.datcollate,
         d.datctype,
         d.datlocprovider,
         ts.spcname AS tablespace,
         d.datconnlimit,
         d.datistemplate,
         shobj_description(d.oid, 'pg_database') AS comment
       FROM pg_database d
       LEFT JOIN pg_tablespace ts ON ts.oid = d.dattablespace
       WHERE d.datname = $1`,
      [target.databaseName]
    );

    const row = result.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const ddl = [
      `CREATE DATABASE ${quoteIdent(row.datname)}`,
      '    WITH',
      `    OWNER = ${quoteIdent(row.owner)}`,
      `    ENCODING = '${row.encoding}'`,
      `    LC_COLLATE = '${row.datcollate}'`,
      `    LC_CTYPE = '${row.datctype}'`,
      `    LOCALE_PROVIDER = '${row.datlocprovider === 'c' ? 'libc' : 'icu'}'`,
      `    TABLESPACE = ${quoteIdent(row.tablespace || 'pg_default')}`,
      `    CONNECTION LIMIT = ${row.datconnlimit}`,
      `    IS_TEMPLATE = ${row.datistemplate ? 'True' : 'False'};`
    ].join('\n');

    const comment = row.comment
      ? `COMMENT ON DATABASE ${quoteIdent(row.datname)} IS '${String(row.comment).replace(/'/g, "''")}';`
      : '';

    return appendDownOperation(
      [ddl, comment].filter(Boolean).join('\n\n'),
      `DROP DATABASE ${quoteIdent(row.datname)};`
    );
  }

  private async generateSchemaDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT
         n.nspname,
         pg_get_userbyid(n.nspowner) AS owner,
         obj_description(n.oid, 'pg_namespace') AS comment,
         n.nspacl
       FROM pg_namespace n
       WHERE n.nspname = $1`,
      [target.objectName || target.schema]
    );

    const row = result.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const grants = await client.query(
      `SELECT
         CASE
           WHEN acl.grantee = 0 THEN 'PUBLIC'
           ELSE pg_get_userbyid(acl.grantee)
         END AS grantee,
         acl.privilege_type
       FROM pg_namespace n
       CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
       WHERE n.nspname = $1
       ORDER BY grantee, privilege_type`,
      [row.nspname]
    );

    const grantLines = grants.rows.map((g: any) =>
      `GRANT ${g.privilege_type} ON SCHEMA ${quoteIdent(row.nspname)} TO ${quoteIdent(g.grantee)};`
    );

    const comment = row.comment
      ? `COMMENT ON SCHEMA ${quoteIdent(row.nspname)} IS '${String(row.comment).replace(/'/g, "''")}';`
      : '';

    return appendDownOperation([
      `-- Schema definition`,
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(row.nspname)} AUTHORIZATION ${quoteIdent(row.owner)};`,
      `ALTER SCHEMA ${quoteIdent(row.nspname)} OWNER TO ${quoteIdent(row.owner)};`,
      grantLines.length > 0 ? ['\n-- Privileges', ...grantLines].join('\n') : '',
      comment
    ].filter(Boolean).join('\n\n'),
    `DROP SCHEMA ${quoteIdent(row.nspname)} CASCADE;`);
  }

  private async generateTableDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const metaResult = await client.query(
      `SELECT
         c.oid,
         pg_get_userbyid(c.relowner) AS owner,
         COALESCE(ts.spcname, 'pg_default') AS tablespace,
         c.reltuples::bigint AS estimated_rows,
         c.relkind,
         c.relrowsecurity,
         c.relispartition,
         pg_get_partkeydef(c.oid) AS partition_key,
         obj_description(c.oid, 'pg_class') AS table_comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
       WHERE n.nspname = $1
         AND c.relname = $2
         AND c.relkind IN ('r', 'p')`,
      [target.schema, target.objectName]
    );

    const tableMeta = metaResult.rows[0];
    if (!tableMeta) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const columnsResult = await client.query(
      `SELECT
         a.attname AS column_name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS not_null,
         pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
         col_description(a.attrelid, a.attnum) AS column_comment
       FROM pg_attribute a
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE a.attrelid = $1
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [tableMeta.oid]
    );

    const constraintsResult = await client.query(
      `SELECT
         con.conname,
         con.contype,
         pg_get_constraintdef(con.oid, true) AS definition
       FROM pg_constraint con
       WHERE con.conrelid = $1
       ORDER BY
         CASE con.contype
           WHEN 'p' THEN 1
           WHEN 'u' THEN 2
           WHEN 'c' THEN 3
           WHEN 'f' THEN 4
           ELSE 5
         END,
         con.conname`,
      [tableMeta.oid]
    );

    const indexesResult = await client.query(
      `SELECT
         ix.indisprimary AS is_primary,
         pg_get_indexdef(i.oid) AS definition
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       WHERE ix.indrelid = $1
       ORDER BY i.relname`,
      [tableMeta.oid]
    );

    const columnLines = columnsResult.rows.map((row: any) => {
      const parts = [
        `${quoteIdent(row.column_name)} ${row.data_type}`,
        row.default_value ? `DEFAULT ${row.default_value}` : '',
        row.not_null ? 'NOT NULL' : ''
      ].filter(Boolean);
      return `    ${parts.join(' ')}`;
    });

    const tableName = `${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)}`;
    const createTable = [
      `CREATE TABLE ${tableName} (`,
      columnLines.join(',\n'),
      ')',
      tableMeta.relkind === 'p' && tableMeta.partition_key ? `PARTITION BY ${tableMeta.partition_key}` : '',
      `TABLESPACE ${quoteIdent(tableMeta.tablespace)};`
    ].join('\n');

    const alterConstraints = constraintsResult.rows.map((row: any) => (
      `ALTER TABLE ONLY ${tableName} ADD CONSTRAINT ${quoteIdent(row.conname)} ${row.definition};`
    ));

    const indexLines = indexesResult.rows
      .filter((row: any) => !row.is_primary)
      .map((row: any) => ensureSemicolon(row.definition));

    const ownerLine = `ALTER TABLE IF EXISTS ${tableName} OWNER TO ${quoteIdent(tableMeta.owner)};`;

    const triggerResult = await client.query(
      `SELECT pg_get_triggerdef(t.oid, true) AS definition
       FROM pg_trigger t
       WHERE t.tgrelid = $1
         AND NOT t.tgisinternal
       ORDER BY t.tgname`,
      [tableMeta.oid]
    );
    const triggerLines = triggerResult.rows.map((r: any) => ensureSemicolon(r.definition));

    const policyResult = await client.query(
      `SELECT
         p.polname,
         p.polpermissive,
         p.polcmd,
         CASE WHEN p.polroles = '{0}'::oid[] THEN 'PUBLIC'
              ELSE array_to_string(array(SELECT pg_get_userbyid(x) FROM unnest(p.polroles) x), ', ')
         END AS roles,
         pg_get_expr(p.polqual, p.polrelid) AS using_expr,
         pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
       FROM pg_policy p
       WHERE p.polrelid = $1
       ORDER BY p.polname`,
      [tableMeta.oid]
    );
    const policyLines = policyResult.rows.map((p: any) => {
      const cmd = p.polcmd === 'r' ? 'SELECT' : p.polcmd === 'a' ? 'INSERT' : p.polcmd === 'w' ? 'UPDATE' : p.polcmd === 'd' ? 'DELETE' : 'ALL';
      const usingClause = p.using_expr ? `\n    USING (${p.using_expr})` : '';
      const checkClause = p.with_check_expr ? `\n    WITH CHECK (${p.with_check_expr})` : '';
      return `CREATE POLICY ${quoteIdent(p.polname)} ON ${tableName}\n    AS ${p.polpermissive ? 'PERMISSIVE' : 'RESTRICTIVE'}\n    FOR ${cmd}\n    TO ${p.roles}${usingClause}${checkClause};`;
    });

    const grants = await client.query(
      `SELECT grantee, privilege_type
       FROM information_schema.role_table_grants
       WHERE table_schema = $1
         AND table_name = $2
       ORDER BY grantee, privilege_type`,
      [target.schema, target.objectName]
    );
    const grantLines = grants.rows.map((g: any) =>
      `GRANT ${g.privilege_type} ON TABLE ${tableName} TO ${quoteIdent(g.grantee)};`
    );

    const tableCommentLine = tableMeta.table_comment
      ? `COMMENT ON TABLE ${tableName} IS '${String(tableMeta.table_comment).replace(/'/g, "''")}';`
      : '';
    const columnCommentLines = columnsResult.rows
      .filter((r: any) => !!r.column_comment)
      .map((r: any) => `COMMENT ON COLUMN ${tableName}.${quoteIdent(r.column_name)} IS '${String(r.column_comment).replace(/'/g, "''")}';`);

    let partitionLines = '';
    if (tableMeta.relkind === 'p') {
      const parts = await client.query(
        `SELECT
           c.relname AS child_name,
           n.nspname AS child_schema,
           pg_get_expr(c.relpartbound, c.oid, true) AS bound
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE i.inhparent = $1
         ORDER BY n.nspname, c.relname`,
        [tableMeta.oid]
      );
      partitionLines = parts.rows.length > 0
        ? ['-- Known Partitions', ...parts.rows.map((p: any) => `-- ${p.child_name}: ${p.bound}`)].join('\n')
        : '';
    }

    return appendDownOperation([
      createTable,
      ownerLine,
      alterConstraints.length > 0 ? ['\n-- Constraints', ...alterConstraints].join('\n') : '',
      indexLines.length > 0 ? ['\n-- Indexes', ...indexLines].join('\n') : '',
      triggerLines.length > 0 ? ['\n-- Triggers', ...triggerLines].join('\n') : '',
      tableMeta.relrowsecurity ? `ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;` : '',
      policyLines.length > 0 ? ['\n-- RLS Policies', ...policyLines].join('\n') : '',
      partitionLines,
      grantLines.length > 0 ? ['\n-- Privileges', ...grantLines].join('\n') : '',
      tableCommentLine,
      columnCommentLines.length > 0 ? ['\n-- Column Comments', ...columnCommentLines].join('\n') : ''
    ].filter(Boolean).join('\n\n'),
    `DROP TABLE ${tableName} CASCADE;`);
  }

  private async generatePartitionDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT
         c.oid,
         c.relname AS child_name,
         n.nspname AS child_schema,
         p.relname AS parent_name,
         pn.nspname AS parent_schema,
         pg_get_expr(c.relpartbound, c.oid, true) AS bound,
         COALESCE(ts.spcname, 'pg_default') AS tablespace
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace pn ON pn.oid = p.relnamespace
       LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
       WHERE n.nspname = $1
         AND c.relname = $2`,
      [target.schema, target.objectName]
    );
    const row = result.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const indexResult = await client.query(
      `SELECT pg_get_indexdef(i.oid) AS definition
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       WHERE ix.indrelid = $1
       ORDER BY i.relname`,
      [row.oid]
    );

    const indexes = indexResult.rows.map((r: any) => ensureSemicolon(r.definition));

    return appendDownOperation([
      `CREATE TABLE ${quoteIdent(row.child_schema)}.${quoteIdent(row.child_name)}`,
      `    PARTITION OF ${quoteIdent(row.parent_schema)}.${quoteIdent(row.parent_name)}`,
      `    ${row.bound}`,
      `    TABLESPACE ${quoteIdent(row.tablespace)};`,
      indexes.length > 0 ? ['\n-- Indexes on this partition', ...indexes].join('\n') : ''
    ].filter(Boolean).join('\n\n'),
    [
      `ALTER TABLE ${quoteIdent(row.parent_schema)}.${quoteIdent(row.parent_name)} DETACH PARTITION ${quoteIdent(row.child_schema)}.${quoteIdent(row.child_name)};`,
      `DROP TABLE ${quoteIdent(row.child_schema)}.${quoteIdent(row.child_name)};`
    ]);
  }

  private async generateColumnDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const tableName = target.tableName;
    if (!tableName || !target.schema || !target.objectName) {
      return '-- Column metadata requires table context.';
    }

    // Tree labels can include type suffixes like "col_name (text)"; strip that for lookup.
    const rawColumnName = target.objectName;
    const columnName = rawColumnName.includes(' (')
      ? rawColumnName.split(' (')[0].trim()
      : rawColumnName;

    const col = await client.query(
      `SELECT
         c.oid AS table_oid,
         a.attnum,
         a.attname,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         NOT a.attnotnull AS is_nullable,
         pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
         CASE a.attstorage
           WHEN 'p' THEN 'plain'
           WHEN 'm' THEN 'main'
           WHEN 'x' THEN 'extended'
           WHEN 'e' THEN 'external'
         END AS storage,
         a.attstattarget AS stats_target,
         col_description(a.attrelid, a.attnum) AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = $1
         AND c.relname = $2
         AND a.attname = $3
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [target.schema, tableName, columnName]
    );
    const row = col.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const con = await client.query(
      `SELECT conname, pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint
       WHERE conrelid = $1
         AND $2 = ANY (conkey)
       ORDER BY conname`,
      [row.table_oid, row.attnum]
    );
    const idx = await client.query(
      `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS definition
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       WHERE ix.indrelid = $1
         AND $2 = ANY (ix.indkey)
       ORDER BY i.relname`,
      [row.table_oid, row.attnum]
    );

    const tableFqn = `${quoteIdent(target.schema)}.${quoteIdent(tableName)}`;
    const commentLine = row.comment
      ? `COMMENT ON COLUMN ${tableFqn}.${quoteIdent(columnName)} IS '${String(row.comment).replace(/'/g, "''")}';`
      : '';

    const alterStatements = [
      `ALTER TABLE ONLY ${tableFqn}`,
      `    ALTER COLUMN ${quoteIdent(columnName)} TYPE ${row.data_type};`,
      row.default_expr ? `ALTER TABLE ONLY ${tableFqn} ALTER COLUMN ${quoteIdent(columnName)} SET DEFAULT ${row.default_expr};` : '',
      row.is_nullable ? `ALTER TABLE ONLY ${tableFqn} ALTER COLUMN ${quoteIdent(columnName)} DROP NOT NULL;` : `ALTER TABLE ONLY ${tableFqn} ALTER COLUMN ${quoteIdent(columnName)} SET NOT NULL;`,
      row.comment ? commentLine : ''
    ].filter(Boolean).join('\n');

    return appendDownOperation([
      '-- Column definition (ALTER TABLE script)',
      alterStatements,
      '',
      '-- Full metadata:',
      `-- Table:       ${target.schema}.${tableName}`,
      `-- Data Type:   ${row.data_type}`,
      `-- Nullable:    ${row.is_nullable ? 'YES' : 'NO'}`,
      `-- Default:     ${row.default_expr || '(none)'}`,
      `-- Storage:     ${row.storage || '(default)'}`,
      `-- Stats Target: ${row.stats_target ?? '-1'}`,
      '',
      '-- Constraints involving this column:',
      con.rows.length > 0 ? con.rows.map((c: any) => `-- ${c.conname}: ${c.definition}`).join('\n') : '-- (none)',
      '',
      '-- Indexes involving this column:',
      idx.rows.length > 0 ? idx.rows.map((i: any) => `-- ${i.name}: ${i.definition}`).join('\n') : '-- (none)',
      commentLine
    ].filter(Boolean).join('\n'),
    `ALTER TABLE ONLY ${tableFqn} DROP COLUMN ${quoteIdent(columnName)};`);
  }

  private async generateViewDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT definition
       FROM pg_views
       WHERE schemaname = $1
         AND viewname = $2`,
      [target.schema, target.objectName]
    );

    if (result.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const owner = await client.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [target.schema, target.objectName]
    );
    const grants = await client.query(
      `SELECT grantee, privilege_type
       FROM information_schema.role_table_grants
       WHERE table_schema = $1
         AND table_name = $2
       ORDER BY grantee, privilege_type`,
      [target.schema, target.objectName]
    );

    const tableName = `${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)}`;

    return appendDownOperation([
      `-- View definition`,
      `CREATE OR REPLACE VIEW ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} AS`,
      `${result.rows[0].definition};`,
      owner.rows[0]?.owner ? `ALTER VIEW ${tableName} OWNER TO ${quoteIdent(owner.rows[0].owner)};` : '',
      grants.rows.length > 0 ? ['-- Privileges', ...grants.rows.map((g: any) => `GRANT ${g.privilege_type} ON TABLE ${tableName} TO ${quoteIdent(g.grantee)};`)].join('\n') : '',
      owner.rows[0]?.comment ? `COMMENT ON VIEW ${tableName} IS '${String(owner.rows[0].comment).replace(/'/g, "''")}';` : ''
    ].filter(Boolean).join('\n\n'),
    `DROP VIEW ${tableName} CASCADE;`);
  }

  private async generateRuleDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const res = await client.query(
      `SELECT pg_get_ruledef(r.oid, true) AS definition
       FROM pg_rewrite r
       JOIN pg_class c ON c.oid = r.ev_class
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND r.rulename = $2
       ORDER BY c.relname
       LIMIT 1`,
      [target.schema, target.objectName]
    );
    if (res.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }
    return appendDownOperation(
      ['-- Rule definition', ensureSemicolon(res.rows[0].definition)].join('\n'),
      `DROP RULE ${quoteIdent(target.objectName!)} ON ${quoteIdent(target.schema!)}.${quoteIdent(target.tableName!)};`
    );
  }

  private async generateRoutineDdl(
    client: PoolClient,
    target: DdlViewerTarget,
    routineType: 'function' | 'procedure'
  ): Promise<string> {
    const prokind = routineType === 'function' ? 'f' : 'p';

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1
         AND p.proname = $2
         AND p.prokind = $3`,
      [target.schema, target.objectName, prokind]
    );

    const result = await client.query(
      `SELECT pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1
         AND p.proname = $2
         AND p.prokind = $3
       ORDER BY p.oid
       LIMIT 1`,
      [target.schema, target.objectName, prokind]
    );

    if (result.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const overloadCount = Number(countResult.rows[0]?.count || 0);
    const prefix = overloadCount > 1
      ? `-- NOTE: Found ${overloadCount} overloads. Showing the first match.\n\n`
      : '';

    const ownerResult = await client.query(
      `SELECT
         p.oid,
         pg_get_userbyid(p.proowner) AS owner,
         p.oid::regprocedure::text AS signature,
         obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1
         AND p.proname = $2
         AND p.prokind = $3
       ORDER BY p.oid
       LIMIT 1`,
      [target.schema, target.objectName, prokind]
    );

    const owner = ownerResult.rows[0];
    const grants = await client.query(
      `SELECT grantee, privilege_type
       FROM information_schema.role_routine_grants
       WHERE routine_schema = $1
         AND routine_name = $2
       ORDER BY grantee, privilege_type`,
      [target.schema, target.objectName]
    );

    const alterLine = owner
      ? `ALTER ${routineType.toUpperCase()} ${owner.signature} OWNER TO ${quoteIdent(owner.owner)};`
      : '';
    const grantLines = grants.rows.map((g: any) =>
      `GRANT ${g.privilege_type} ON ${routineType.toUpperCase()} ${owner.signature} TO ${quoteIdent(g.grantee)};`
    );
    const commentLine = owner?.comment
      ? `COMMENT ON ${routineType.toUpperCase()} ${owner.signature} IS '${String(owner.comment).replace(/'/g, "''")}';`
      : '';

    return appendDownOperation([
      `-- ${routineType.toUpperCase()} definition`,
      `${prefix}${result.rows[0].definition}`,
      alterLine,
      grantLines.length > 0 ? ['-- Privileges', ...grantLines].join('\n') : '',
      commentLine
    ].filter(Boolean).join('\n\n'),
    `DROP ${routineType.toUpperCase()} ${owner.signature};`);
  }

  private async generateConstraintDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const res = await client.query(
      `SELECT
         con.oid,
         con.conname,
         con.contype,
         con.conrelid,
         con.conindid,
         con.condeferrable,
         con.condeferred,
         n.nspname AS schema_name,
         c.relname AS table_name,
         pg_get_constraintdef(con.oid, true) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE con.conname = $1
         AND ($2::text IS NULL OR n.nspname = $2)
       ORDER BY n.nspname, c.relname
       LIMIT 1`,
      [target.objectName, target.schema || null]
    );
    const row = res.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const tableName = `${quoteIdent(row.schema_name)}.${quoteIdent(row.table_name)}`;
    const typeMap: Record<string, string> = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK' };

    const base = [
      '-- Constraint definition',
      `ALTER TABLE ONLY ${tableName}`,
      `    ADD CONSTRAINT ${quoteIdent(row.conname)} ${row.definition};`,
      '',
      '-- Constraint metadata:',
      `-- Type:       ${typeMap[row.contype] || row.contype}`,
      `-- Deferrable: ${row.condeferrable ? 'YES' : 'NO'}`,
      `-- Deferred:   ${row.condeferred ? 'YES' : 'NO'}`
    ];

    return appendDownOperation(base.join('\n'), `ALTER TABLE ONLY ${tableName} DROP CONSTRAINT ${quoteIdent(row.conname)};`);
  }

  private async generateIndexDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    let result = await client.query(
      `SELECT
         i.indexdef,
         i.tablename,
         c.oid,
         ix.indisunique AS is_unique,
         ix.indisprimary AS is_primary,
         pg_size_pretty(pg_relation_size(c.oid)) AS size,
         COALESCE(s.idx_scan, 0) AS scans,
         COALESCE(s.idx_tup_read, 0) AS tuples_read,
         COALESCE(s.idx_tup_fetch, 0) AS tuples_fetched
       FROM pg_indexes
       i
       JOIN pg_class c ON c.relname = i.indexname
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
       LEFT JOIN pg_index ix ON ix.indexrelid = c.oid
       LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
       WHERE schemaname = $1
         AND indexname = $2`,
      [target.schema, target.objectName]
    );

    // Prefer table-scoped lookup when context is available to avoid collisions or stale names.
    if (result.rows.length === 0 && target.schema && target.tableName) {
      result = await client.query(
        `SELECT
           i.indexdef,
           i.tablename,
           c.oid,
           ix.indisunique AS is_unique,
           ix.indisprimary AS is_primary,
           pg_size_pretty(pg_relation_size(c.oid)) AS size,
           COALESCE(s.idx_scan, 0) AS scans,
           COALESCE(s.idx_tup_read, 0) AS tuples_read,
           COALESCE(s.idx_tup_fetch, 0) AS tuples_fetched
         FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
         LEFT JOIN pg_index ix ON ix.indexrelid = c.oid
         LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
         WHERE i.schemaname = $1
           AND i.tablename = $2
           AND i.indexname = $3`,
        [target.schema, target.tableName, target.objectName]
      );
    }

    if (result.rows.length === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const row = result.rows[0];
    return appendDownOperation([
      '-- Index definition',
      `-- Table: ${target.schema}.${row.tablename}`,
      '',
      ensureSemicolon(row.indexdef),
      '',
      '-- Index metadata:',
      `-- Size:         ${row.size}`,
      `-- Unique:       ${row.is_unique ? 'YES' : 'NO'}`,
      `-- Primary:      ${row.is_primary ? 'YES' : 'NO'}`,
      `-- Scans:        ${row.scans}`,
      `-- Tuples Read:  ${row.tuples_read}`,
      `-- Tuples Fetched: ${row.tuples_fetched}`
    ].join('\n'),
    `DROP INDEX ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)};`);
  }

  private async generateMaterializedViewDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT definition
       FROM pg_matviews
       WHERE schemaname = $1
         AND matviewname = $2`,
      [target.schema, target.objectName]
    );

    if (result.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const owner = await client.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [target.schema, target.objectName]
    );

    const indexes = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [target.schema, target.objectName]
    );

    const grants = await client.query(
      `SELECT grantee, privilege_type
       FROM information_schema.role_table_grants
       WHERE table_schema = $1
         AND table_name = $2
       ORDER BY grantee, privilege_type`,
      [target.schema, target.objectName]
    );

    const tableName = `${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)}`;

    return appendDownOperation([
      `-- Materialized view definition`,
      `CREATE MATERIALIZED VIEW ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} AS`,
      `${result.rows[0].definition}`,
      'WITH DATA;',
      owner.rows[0]?.owner ? `ALTER MATERIALIZED VIEW ${tableName} OWNER TO ${quoteIdent(owner.rows[0].owner)};` : '',
      indexes.rows.length > 0 ? ['-- Indexes', ...indexes.rows.map((i: any) => ensureSemicolon(i.indexdef))].join('\n') : '',
      grants.rows.length > 0 ? ['-- Privileges', ...grants.rows.map((g: any) => `GRANT ${g.privilege_type} ON TABLE ${tableName} TO ${quoteIdent(g.grantee)};`)].join('\n') : ''
    ].filter(Boolean).join('\n\n'),
    `DROP MATERIALIZED VIEW ${tableName} CASCADE;`);
  }

  private async generateSequenceDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT
         data_type,
         start_value,
         min_value,
         max_value,
         increment_by,
         cycle,
         cache_size
       FROM pg_sequences
       WHERE schemaname = $1
         AND sequencename = $2`,
      [target.schema, target.objectName]
    );

    if (result.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const row = result.rows[0];
    const details = await client.query(
      `SELECT
         c.oid,
         pg_get_userbyid(c.relowner) AS owner,
         s.last_value,
         pg_get_serial_sequence($1, $2) AS owned_by
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} s ON TRUE
       WHERE n.nspname = $3
         AND c.relname = $4`,
      [`${target.schema}.${target.tableName || target.objectName}`, target.objectName, target.schema, target.objectName]
    ).catch(async () => {
      return client.query(
        `SELECT c.oid, pg_get_userbyid(c.relowner) AS owner, NULL::bigint AS last_value, NULL::text AS owned_by
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [target.schema, target.objectName]
      );
    });

    const info = details.rows[0] || {};
    return appendDownOperation([
      `-- Sequence definition`,
      `CREATE SEQUENCE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)}`,
      `    AS ${row.data_type}`,
      `    INCREMENT BY ${row.increment_by}`,
      `    MINVALUE ${row.min_value}`,
      `    MAXVALUE ${row.max_value}`,
      `    START WITH ${row.start_value}`,
      `    CACHE ${row.cache_size}`,
      `    ${row.cycle ? 'CYCLE' : 'NO CYCLE'};`,
      info.owned_by ? `ALTER SEQUENCE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} OWNED BY ${info.owned_by};` : '',
      info.owner ? `ALTER SEQUENCE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} OWNER TO ${quoteIdent(info.owner)};` : '',
      info.last_value !== undefined && info.last_value !== null ? `-- Current value: ${info.last_value}` : ''
    ].filter(Boolean).join('\n\n'),
    `DROP SEQUENCE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)};`);
  }

  private async generateTypeDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT
         a.attname AS field_name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS field_type
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_class c ON c.oid = t.typrelid
       JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE n.nspname = $1
         AND t.typname = $2
         AND t.typtype = 'c'
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [target.schema, target.objectName]
    );

    if (result.rows.length > 0) {
      const fieldLines = result.rows.map((row: any) => `    ${quoteIdent(row.field_name)} ${row.field_type}`);
      return appendDownOperation([
        `-- Type definition`,
        `CREATE TYPE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} AS (`,
        fieldLines.join(',\n'),
        ');'
      ].join('\n'),
      `DROP TYPE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)};`);
    }

    const enums = await client.query(
      `SELECT e.enumlabel
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname = $1
         AND t.typname = $2
       ORDER BY e.enumsortorder`,
      [target.schema, target.objectName]
    );
    if (enums.rows.length > 0) {
      return appendDownOperation(
        `-- Type definition\nCREATE TYPE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} AS ENUM (\n${enums.rows.map((r: any) => `    '${String(r.enumlabel).replace(/'/g, "''")}'`).join(',\n')}\n);`,
        `DROP TYPE ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)};`
      );
    }

    return '-- DDL generation for TYPE is not yet supported.';
  }

  private async generateDomainDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const row = await client.query(
      `SELECT
         t.typname,
         format_type(t.typbasetype, t.typtypmod) AS base_type,
         t.typnotnull,
         pg_get_expr(t.typdefaultbin, 0) AS default_expr
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1
         AND t.typname = $2
         AND t.typtype = 'd'`,
      [target.schema, target.objectName]
    );
    if (row.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }
    const d = row.rows[0];
    return appendDownOperation([
      `-- Domain definition`,
      `CREATE DOMAIN ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)} AS ${d.base_type}`,
      d.default_expr ? `    DEFAULT ${d.default_expr}` : '',
      d.typnotnull ? '    NOT NULL' : ''
    ].filter(Boolean).join('\n') + ';',
    `DROP DOMAIN ${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)};`);
  }

  private async generateTriggerDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const result = await client.query(
      `SELECT
         pg_get_triggerdef(t.oid, true) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND t.tgname = $2
         AND NOT t.tgisinternal
         AND ($3::text IS NULL OR c.relname = $3)
       ORDER BY c.relname
       LIMIT 1`,
      [target.schema, target.objectName, target.tableName || null]
    );

    if (result.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const meta = await client.query(
      `SELECT
         t.tgenabled,
         i.action_timing,
         string_agg(DISTINCT i.event_manipulation, ', ' ORDER BY i.event_manipulation) AS events
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN information_schema.triggers i
         ON i.trigger_schema = n.nspname
        AND i.event_object_table = c.relname
        AND i.trigger_name = t.tgname
       WHERE n.nspname = $1
         AND t.tgname = $2
         AND NOT t.tgisinternal
         AND ($3::text IS NULL OR c.relname = $3)
       GROUP BY t.tgenabled`,
      [target.schema, target.objectName, target.tableName || null]
    );
    const m = meta.rows[0];

    return appendDownOperation([
      '-- Trigger definition',
      ensureSemicolon(result.rows[0].definition),
      '',
      `-- Enabled: ${m?.tgenabled === 'D' ? 'NO' : 'YES'}`,
      `-- Timing:  ${m?.action_timing || 'UNKNOWN'}`,
      `-- Events:  ${m?.events || 'UNKNOWN'}`
    ].join('\n'),
    `DROP TRIGGER ${quoteIdent(target.objectName!)} ON ${quoteIdent(target.schema!)}.${quoteIdent(target.tableName!)};`);
  }

  private async generatePolicyDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    if (!target.tableName || !target.schema) {
      return '-- Policy metadata requires table context.';
    }

    const res = await client.query(
      `SELECT
         p.polname,
         p.polpermissive,
         p.polcmd,
         CASE WHEN p.polroles = '{0}'::oid[] THEN 'PUBLIC'
              ELSE array_to_string(array(SELECT pg_get_userbyid(x) FROM unnest(p.polroles) x), ', ')
         END AS roles,
         pg_get_expr(p.polqual, p.polrelid) AS using_expr,
         pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relname = $2
         AND p.polname = $3`,
      [target.schema, target.tableName, target.objectName]
    );
    if (res.rowCount === 0) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }
    const p = res.rows[0];
    const cmd = p.polcmd === 'r' ? 'SELECT' : p.polcmd === 'a' ? 'INSERT' : p.polcmd === 'w' ? 'UPDATE' : p.polcmd === 'd' ? 'DELETE' : 'ALL';
    const tableName = `${quoteIdent(target.schema)}.${quoteIdent(target.tableName)}`;
    return appendDownOperation([
      '-- Policy definition',
      `CREATE POLICY ${quoteIdent(p.polname)}`,
      `    ON ${tableName}`,
      `    AS ${p.polpermissive ? 'PERMISSIVE' : 'RESTRICTIVE'}`,
      `    FOR ${cmd}`,
      `    TO ${p.roles}`,
      p.using_expr ? `    USING (${p.using_expr})` : '',
      p.with_check_expr ? `    WITH CHECK (${p.with_check_expr})` : ''
    ].filter(Boolean).join('\n') + ';',
    `DROP POLICY ${quoteIdent(p.polname)} ON ${tableName};`);
  }

  private async generateExtensionDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const res = await client.query(
      `SELECT
         e.extname,
         e.extversion,
         n.nspname AS schema_name,
         a.default_version,
         a.comment
       FROM pg_extension e
       LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
       LEFT JOIN pg_available_extensions a ON a.name = e.extname
       WHERE e.extname = $1`,
      [target.objectName]
    );
    const row = res.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    return appendDownOperation([
      '-- Extension definition',
      `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(row.extname)}`,
      row.schema_name ? `    SCHEMA ${quoteIdent(row.schema_name)}` : '',
      row.extversion ? `    VERSION '${row.extversion}';` : ';',
      row.comment ? `-- Description: ${row.comment}` : '',
      row.extversion ? `-- Installed Version: ${row.extversion}` : '',
      row.default_version ? `-- Default Version: ${row.default_version}` : ''
    ].filter(Boolean).join('\n'),
    `DROP EXTENSION ${quoteIdent(row.extname)};`);
  }

  private async generateRoleDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const res = await client.query(
      `SELECT
         rolname,
         rolsuper,
         rolinherit,
         rolcreaterole,
         rolcreatedb,
         rolcanlogin,
         rolreplication,
         rolconnlimit
       FROM pg_roles
       WHERE rolname = $1`,
      [target.objectName]
    );
    const row = res.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const memberships = await client.query(
      `SELECT parent.rolname AS role_name
       FROM pg_auth_members m
       JOIN pg_roles child ON child.oid = m.member
       JOIN pg_roles parent ON parent.oid = m.roleid
       WHERE child.rolname = $1
       ORDER BY parent.rolname`,
      [target.objectName]
    );

    const create = [
      `CREATE ROLE ${quoteIdent(row.rolname)} WITH`,
      `    ${row.rolcanlogin ? 'LOGIN' : 'NOLOGIN'}`,
      `    ${row.rolsuper ? 'SUPERUSER' : 'NOSUPERUSER'}`,
      `    ${row.rolcreatedb ? 'CREATEDB' : 'NOCREATEDB'}`,
      `    ${row.rolcreaterole ? 'CREATEROLE' : 'NOCREATEROLE'}`,
      `    ${row.rolinherit ? 'INHERIT' : 'NOINHERIT'}`,
      `    ${row.rolreplication ? 'REPLICATION' : 'NOREPLICATION'}`,
      `    CONNECTION LIMIT ${row.rolconnlimit}`,
      `    PASSWORD '********';`
    ].join('\n');

    const grantLines = memberships.rows.map((m: any) => `GRANT ${quoteIdent(m.role_name)} TO ${quoteIdent(row.rolname)};`);

    return appendDownOperation(
      [create, grantLines.length > 0 ? ['-- Role memberships', ...grantLines].join('\n') : ''].filter(Boolean).join('\n\n'),
      `DROP ROLE ${quoteIdent(row.rolname)};`
    );
  }

  private async generateForeignTableDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const def = await client.query(
      `SELECT
         c.oid,
         c.relname,
         n.nspname,
         s.srvname,
         pg_get_userbyid(c.relowner) AS owner,
         ft.ftoptions
       FROM pg_foreign_table ft
       JOIN pg_class c ON c.oid = ft.ftrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_foreign_server s ON s.oid = ft.ftserver
       WHERE n.nspname = $1
         AND c.relname = $2`,
      [target.schema, target.objectName]
    );
    const row = def.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const cols = await client.query(
      `SELECT
         a.attname,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull
       FROM pg_attribute a
       WHERE a.attrelid = $1
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [row.oid]
    );

    const colDefs = cols.rows.map((c: any) => `    ${quoteIdent(c.attname)} ${c.data_type}${c.attnotnull ? ' NOT NULL' : ''}`);
    const options = Array.isArray(row.ftoptions) && row.ftoptions.length > 0
      ? `\nOPTIONS (${row.ftoptions.join(', ')})`
      : '';
    const tableName = `${quoteIdent(row.nspname)}.${quoteIdent(row.relname)}`;

    return appendDownOperation([
      '-- Foreign table definition',
      `CREATE FOREIGN TABLE ${tableName} (`,
      colDefs.join(',\n'),
      ')',
      `SERVER ${quoteIdent(row.srvname)}${options};`,
      `ALTER FOREIGN TABLE ${tableName} OWNER TO ${quoteIdent(row.owner)};`
    ].join('\n'),
    `DROP FOREIGN TABLE ${tableName};`);
  }

  private async generateForeignServerDdl(client: PoolClient, target: DdlViewerTarget): Promise<string> {
    const res = await client.query(
      `SELECT
         s.oid,
         s.srvname,
         s.srvtype,
         s.srvoptions,
         fdw.fdwname,
         pg_get_userbyid(s.srvowner) AS owner
       FROM pg_foreign_server s
       JOIN pg_foreign_data_wrapper fdw ON fdw.oid = s.srvfdw
       WHERE s.srvname = $1`,
      [target.objectName]
    );
    const row = res.rows[0];
    if (!row) {
      return '-- Object not found. The tree may be out of sync - try refreshing.';
    }

    const mappings = await client.query(
      `SELECT
         um.usename,
         um.umoptions
       FROM pg_user_mappings um
       WHERE um.srvname = $1
       ORDER BY um.usename`,
      [row.srvname]
    );

    const options = Array.isArray(row.srvoptions) && row.srvoptions.length > 0
      ? `\n    OPTIONS (${row.srvoptions.join(', ')})`
      : '';
    const mappingLines = mappings.rows.map((m: any) => {
      const opts = Array.isArray(m.umoptions)
        ? m.umoptions.map((o: string) => o.toLowerCase().startsWith('password=') ? "password='********'" : o).join(', ')
        : '';
      return [
        `CREATE USER MAPPING FOR ${quoteIdent(m.usename)}`,
        `    SERVER ${quoteIdent(row.srvname)}`,
        opts ? `    OPTIONS (${opts});` : '    ;'
      ].join('\n');
    });

    return appendDownOperation([
      '-- Foreign server definition',
      `CREATE SERVER ${quoteIdent(row.srvname)}`,
      row.srvtype ? `    TYPE '${String(row.srvtype).replace(/'/g, "''")}'` : '',
      `    FOREIGN DATA WRAPPER ${quoteIdent(row.fdwname)}${options};`,
      `ALTER SERVER ${quoteIdent(row.srvname)} OWNER TO ${quoteIdent(row.owner)};`,
      mappingLines.length > 0 ? ['-- User Mappings', ...mappingLines].join('\n') : ''
    ].filter(Boolean).join('\n\n'),
    `DROP SERVER ${quoteIdent(row.srvname)} CASCADE;`);
  }
}

export class DdlViewerService implements vscode.Disposable {
  private readonly provider = new DdlContentProvider();
  private readonly codeLensProvider = new DdlViewerCodeLensProvider();
  private readonly disposables: vscode.Disposable[] = [];
  private lastPreviewTarget: DdlViewerTarget | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly treeView: vscode.TreeView<DatabaseTreeItem>
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(DDL_VIEWER_SCHEME, this.provider),
      vscode.languages.registerCodeLensProvider({ scheme: DDL_VIEWER_SCHEME }, this.codeLensProvider),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(DDL_VIEWER_ENABLED_CONFIG)) {
          this.codeLensProvider.refresh();
          this.refreshOpenPreviewDocuments();
        }
      }),
      this.treeView.onDidChangeSelection(async (event) => {
        if (!isDdlViewerEnabled()) {
          return;
        }

        if (!vscode.workspace.getConfiguration().get<boolean>('pgstudio.ddlViewer.openOnSelection', true)) {
          return;
        }

        const item = event.selection[0];
        if (!item || !item.connectionId || !item.databaseName) {
          return;
        }

        await this.openForItem(item, true);
      }),
      vscode.commands.registerCommand('postgres-explorer.openDefinition', async (item?: DatabaseTreeItem) => {
        const selected = item || this.treeView.selection[0];
        if (!selected || !selected.connectionId || !selected.databaseName) {
          vscode.window.showInformationMessage('Select an object in Database Explorer to view its definition.');
          return;
        }
        await this.openForItem(selected, false);
      }),
      vscode.commands.registerCommand('postgres-explorer.ddlViewer.openEditableCopy', async (uri?: vscode.Uri) => {
        const targetUri = this.resolveDdlUri(uri);
        if (!targetUri) {
          vscode.window.showInformationMessage('Open a SQL Preview tab first.');
          return;
        }
        await this.openEditableCopy(targetUri);
      }),
      vscode.commands.registerCommand('postgres-explorer.ddlViewer.copyToClipboard', async (uri?: vscode.Uri) => {
        const targetUri = this.resolveDdlUri(uri);
        if (!targetUri) {
          vscode.window.showInformationMessage('Open a SQL Preview tab first.');
          return;
        }
        await this.copyToClipboard(targetUri);
      }),
      vscode.commands.registerCommand('postgres-explorer.ddlViewer.executeRoutine', async (uri: vscode.Uri) => {
        await this.openRoutineExecuteScaffold(uri);
      }),
      vscode.commands.registerCommand('postgres-explorer.ddlViewer.toggleEnabled', async (forceState?: boolean) => {
        const current = isDdlViewerEnabled();
        const nextState = typeof forceState === 'boolean' ? forceState : !current;
        await vscode.workspace.getConfiguration().update(DDL_VIEWER_ENABLED_CONFIG, nextState, vscode.ConfigurationTarget.Global);
        this.codeLensProvider.refresh();
        this.refreshOpenPreviewDocuments();
        vscode.window.showInformationMessage(`SQL Preview ${nextState ? 'enabled' : 'disabled'}.`);
      })
    );
  }

  public async openForItem(item: DatabaseTreeItem, fromSelection: boolean): Promise<void> {
    if (!isDdlViewerEnabled()) {
      if (!fromSelection) {
        vscode.window.showInformationMessage('SQL Preview is disabled. Enable it from settings or from a preview tab action.');
      }
      return;
    }

    const target = this.toTarget(item);
    const uri = this.createUri(target);
    this.lastPreviewTarget = target;

    await this.provider.provideTextDocumentContent(uri);
    this.provider.refresh(uri);

    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'sql') {
      await vscode.languages.setTextDocumentLanguage(doc, 'sql');
    }

    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: fromSelection,
      preview: fromSelection
    });
  }

  public dispose(): void {
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private refreshOpenPreviewDocuments(): void {
    this.provider.refreshAllOpenDdlDocuments();
  }

  private resolveDdlUri(uri?: vscode.Uri): vscode.Uri | undefined {
    if (uri?.scheme === DDL_VIEWER_SCHEME) {
      return uri;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme === DDL_VIEWER_SCHEME) {
      return activeUri;
    }

    return undefined;
  }

  private createUri(target: DdlViewerTarget): vscode.Uri {
    const objectDisplay = toObjectDisplayName(target);
    const fileName = `[definition] ${objectDisplay}.pgsql`;
    const encodedPayload = encodeURIComponent(encodeTarget(target));
    return vscode.Uri.parse(`${DDL_VIEWER_SCHEME}://viewer/${encodeURIComponent(fileName)}?data=${encodedPayload}`);
  }

  private toTarget(item: DatabaseTreeItem): DdlViewerTarget {
    const unsupportedTarget: DdlViewerTarget = {
      connectionId: item.connectionId!,
      databaseName: item.databaseName!,
      objectType: 'placeholder',
      objectName: item.label
    };

    const supportedTypes = new Set<DdlObjectType>([
      'database',
      'schema',
      'table',
      'column',
      'view',
      'rule',
      'function',
      'procedure',
      'constraint',
      'index',
      'materialized-view',
      'sequence',
      'type',
      'domain',
      'trigger',
      'extension',
      'role',
      'foreign-table',
      'foreign-data-wrapper',
      'foreign-server',
      'partition',
      'policy'
    ]);

    if (!supportedTypes.has(item.type as DdlObjectType)) {
      return unsupportedTarget;
    }

    const objectName = item.type === 'extension'
      ? item.label.split(' ')[0].replace(/\(.+\)/, '').trim()
      : item.type === 'column'
        ? (item.columnName || item.label.split(' (')[0].trim())
        : item.label;

    return {
      connectionId: item.connectionId!,
      databaseName: item.databaseName!,
      schema: item.type === 'database' ? undefined : item.schema,
      objectType: item.type === 'database'
        ? 'database'
        : item.type === 'partition'
          ? 'partition'
          : item.type as DdlObjectType,
      objectName,
      tableName: item.tableName
    };
  }

  private async copyToClipboard(uri: vscode.Uri): Promise<void> {
    const content = this.provider.getCachedContent(uri) || (await vscode.workspace.openTextDocument(uri)).getText();
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage('Definition copied to clipboard.');
  }

  private async openEditableCopy(uri: vscode.Uri): Promise<void> {
    const target = decodeTarget(uri);
    const content = this.provider.getCachedContent(uri) || (await vscode.workspace.openTextDocument(uri)).getText();

    const connection = await getConnectionWithPassword(target.connectionId, target.databaseName);
    const metadata = createMetadata(connection, target.databaseName);

    const notebookData = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, content, 'sql')
    ]);
    notebookData.metadata = metadata;

    const notebook = await vscode.workspace.openNotebookDocument('postgres-query', notebookData);
    await vscode.window.showNotebookDocument(notebook, { preserveFocus: false, preview: true });
  }

  private async openRoutineExecuteScaffold(uri: vscode.Uri): Promise<void> {
    const target = decodeTarget(uri);
    if (target.objectType !== 'function' && target.objectType !== 'procedure') {
      return;
    }

    const connection = await getConnectionWithPassword(target.connectionId, target.databaseName);
    const metadata = createMetadata(connection, target.databaseName);

    const client = await ConnectionManager.getInstance().getPooledClient({
      id: connection.id,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      database: target.databaseName,
      name: connection.name,
      password: connection.password
    });

    try {
      const prokind = target.objectType === 'function' ? 'f' : 'p';
      const argsResult = await client.query(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1
           AND p.proname = $2
           AND p.prokind = $3
         ORDER BY p.oid
         LIMIT 1`,
        [target.schema, target.objectName, prokind]
      );

      const identityArgs = String(argsResult.rows[0]?.args || '').trim();
      const placeholders = identityArgs
        ? identityArgs
          .split(',')
          .map((arg: string, index: number) => `/* arg${index + 1}: ${arg.trim()} */`)
          .join(', ')
        : '';

      const routineName = `${quoteIdent(target.schema!)}.${quoteIdent(target.objectName!)}`;
      const query = target.objectType === 'function'
        ? `SELECT ${routineName}(${placeholders});`
        : `CALL ${routineName}(${placeholders});`;

      const notebookData = new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, query, 'sql')
      ]);
      notebookData.metadata = metadata;

      const notebook = await vscode.workspace.openNotebookDocument('postgres-query', notebookData);
      await vscode.window.showNotebookDocument(notebook, { preserveFocus: false, preview: true });
    } finally {
      client.release();
    }
  }
}