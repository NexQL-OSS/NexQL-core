import * as vscode from 'vscode';
import { DatabaseTreeItem, DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import {
  MarkdownUtils,
  FormatHelpers,
  ErrorHandlers,
  QueryBuilder,
  NotebookBuilder,
  getDatabaseConnection,
  validateRoleItem
} from './helper';
import { UserRoleSQL } from './sql';

/**
 * Show role properties in a notebook
 */
export async function cmdShowRoleProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { client, metadata } = dbConn;

    const roleName = item.label;

    const roleResult = await client.query(QueryBuilder.roleDetails(roleName));
    if (roleResult.rows.length === 0) {
      vscode.window.showErrorMessage('Role not found');
      return;
    }

    const role = roleResult.rows[0];

    // Build role attributes list
    const attributes = [];
    if (role.rolsuper) attributes.push('⚡ SUPERUSER');
    if (role.rolcanlogin) attributes.push('🔑 LOGIN');
    if (role.rolcreatedb) attributes.push('🗄️ CREATEDB');
    if (role.rolcreaterole) attributes.push('👥 CREATEROLE');
    if (role.rolreplication) attributes.push('🔁 REPLICATION');
    if (role.rolbypassrls) attributes.push('🛡️ BYPASSRLS');
    if (role.rolinherit) attributes.push('👪 INHERIT');

    let markdown = MarkdownUtils.header(`👤 Role Properties: \`${roleName}\``) +
      MarkdownUtils.infoBox('Execute the queries below to get the latest role information from the database.') +
      '\n\n#### 🎭 Role Attributes\n\n' +
      MarkdownUtils.propertiesTable({
        'Role Name': `<code>${role.rolname}</code>`,
        'Superuser': FormatHelpers.formatBoolean(role.rolsuper),
        'Can Login': FormatHelpers.formatBoolean(role.rolcanlogin),
        'Create DB': FormatHelpers.formatBoolean(role.rolcreatedb),
        'Create Role': FormatHelpers.formatBoolean(role.rolcreaterole),
        'Replication': FormatHelpers.formatBoolean(role.rolreplication),
        'Bypass RLS': FormatHelpers.formatBoolean(role.rolbypassrls),
        'Inherit': FormatHelpers.formatBoolean(role.rolinherit),
        'Connection Limit': role.rolconnlimit === -1 ? 'Unlimited' : '' + role.rolconnlimit,
        'Valid Until': role.rolvaliduntil ? '' + role.rolvaliduntil : '∞'
      });

    if (attributes.length > 0) {
      markdown += '\n\n#### 🔑 Active Privileges\n\n' + attributes.join(' | ');
    }

    if (role.member_of && role.member_of.length > 0) {
      markdown += '\n\n#### 👪 Member Of\n\n- ' + role.member_of.join('\n- ');
    }

    if (role.members && role.members.length > 0) {
      markdown += '\n\n#### 👥 Has Members\n\n- ' + role.members.join('\n- ');
    }

    if (role.accessible_databases && role.accessible_databases.length > 0) {
      markdown += '\n\n#### 🗄️ Accessible Databases\n\n- ' + role.accessible_databases.join('\n- ');
    }

    await new NotebookBuilder(metadata)
      .addMarkdown(markdown)
      .addMarkdown('##### 🔍 Query Role Attributes')
      .addSql(`SELECT
    r.rolname,
    r.rolsuper,
    r.rolinherit,
    r.rolcreaterole,
    r.rolcreatedb,
    r.rolcanlogin,
    r.rolreplication,
    r.rolconnlimit,
    r.rolvaliduntil,
    r.rolbypassrls,
    pg_catalog.shobj_description(r.oid, 'pg_authid') as description
FROM pg_roles r
WHERE r.rolname = '${roleName}'`)
      .addMarkdown('##### 👪 Role Memberships')
      .addSql(`-- Roles this role belongs to
SELECT
    m.rolname as "Member Of",
    g.rolname as "Granted By",
    am.admin_option as "Admin Option"
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.member
JOIN pg_roles m ON m.oid = am.roleid
JOIN pg_roles g ON g.oid = am.grantor
WHERE r.rolname = '${roleName}';

-- Roles that belong to this role
SELECT
    m.rolname as "Has Member",
    g.rolname as "Granted By",
    am.admin_option as "Admin Option"
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
JOIN pg_roles g ON g.oid = am.grantor
WHERE r.rolname = '${roleName}';`)
      .addMarkdown('##### 🔐 Granted Privileges')
      .addSql(`-- Table privileges
SELECT
    table_schema as "Schema",
    table_name as "Table",
    privilege_type as "Privilege",
    is_grantable as "Grantable"
FROM information_schema.table_privileges
WHERE grantee = '${roleName}'
ORDER BY table_schema, table_name, privilege_type;

-- Schema privileges
SELECT
    n.nspname as "Schema",
    'USAGE' as "Privilege"
FROM pg_namespace n
WHERE has_schema_privilege('${roleName}', n.nspname, 'USAGE')
AND n.nspname NOT LIKE 'pg_%'
AND n.nspname != 'information_schema';`)
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show role properties');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Copy role name to clipboard
 */
export async function copyRoleName(item: DatabaseTreeItem): Promise<void> {
  const roleName = item.label;
  await vscode.env.clipboard.writeText(roleName);
  vscode.window.showInformationMessage('Copied: ' + roleName);
}

/**
 * Copy role name quoted to clipboard
 */
export async function copyRoleNameQuoted(item: DatabaseTreeItem): Promise<void> {
  const roleName = item.label;
  await vscode.env.clipboard.writeText('"' + roleName + '"');
  vscode.window.showInformationMessage('Copied: "' + roleName + '"');
}

/**
 * Generate CREATE USER script — single-operation notebook
 */
export async function cmdAddUser(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Create New User\n\nCreate a new PostgreSQL user with login privileges.`)
      .addSql(UserRoleSQL.createUser(item.databaseName || 'database_name'))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create user notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Generate CREATE ROLE script — single-operation notebook
 */
export async function cmdAddRole(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ➕ Create New Role\n\nCreate a new PostgreSQL role for grouping privileges.`)
      .addSql(UserRoleSQL.createRole())
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create role notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Generate ALTER ROLE script — single-operation notebook
 */
export async function cmdEditRole(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ✏️ Edit Role: \`${item.label}\`\n\nModify role attributes using ALTER ROLE.`)
      .addSql(UserRoleSQL.alterRole(item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'edit role');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Generate GRANT script — single-operation notebook
 */
export async function cmdGrantRevokeRole(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🔐 Manage Privileges: \`${item.label}\`\n\nGrant or revoke privileges for this role.`)
      .addSql(UserRoleSQL.grant(item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'manage privileges');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Generate DROP ROLE script — single-operation notebook
 */
export async function cmdDropRole(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### ❌ Drop Role: \`${item.label}\`\n\n⚠️ **Warning:** This permanently deletes the role. Reassign or drop owned objects first.`)
      .addSql(UserRoleSQL.dropRole(item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'drop role');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Show role operations notebook — Operations_Notebook
 * Cell order: read → write/modify → destructive
 */
export async function cmdRoleOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🛠️ Role Operations: \`${item.label}\`\n\nCommon operations for this PostgreSQL role.`)
      .addMarkdown('##### 🔍 Role Attributes')
      .addSql(`-- View role attributes
SELECT
    r.rolname as "Name",
    r.rolsuper as "Superuser",
    r.rolinherit as "Inherit",
    r.rolcreaterole as "Create Role",
    r.rolcreatedb as "Create DB",
    r.rolcanlogin as "Can Login",
    r.rolreplication as "Replication",
    r.rolconnlimit as "Connection Limit",
    r.rolvaliduntil as "Valid Until",
    r.rolbypassrls as "Bypass RLS",
    pg_catalog.shobj_description(r.oid, 'pg_authid') as "Description"
FROM pg_roles r
WHERE r.rolname = '${item.label}';`)
      .addMarkdown('##### ✏️ ALTER ROLE')
      .addSql(UserRoleSQL.alterRole(item.label))
      .addMarkdown('##### 🔐 GRANT Privileges')
      .addSql(UserRoleSQL.grant(item.label))
      .addMarkdown('##### ❌ DROP ROLE — ⚠️ Warning: permanently deletes the role')
      .addSql(UserRoleSQL.dropRole(item.label))
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show role operations');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * View role dependencies
 */
export async function viewRoleDependencies(item: DatabaseTreeItem): Promise<void> {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateRoleItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(`### 🔗 Role Dependencies: \`${item.label}\`\n\nShows objects owned by or dependent on this role.`)
      .addSql(`-- Objects owned by this role
SELECT
    n.nspname as "Schema",
    c.relname as "Object Name",
    CASE c.relkind
        WHEN 'r' THEN 'Table'
        WHEN 'v' THEN 'View'
        WHEN 'm' THEN 'Materialized View'
        WHEN 'S' THEN 'Sequence'
        WHEN 'f' THEN 'Foreign Table'
        ELSE c.relkind::text
    END as "Type"
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE r.rolname = '${item.label}'
ORDER BY n.nspname, c.relname;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'view role dependencies');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * Refresh role in tree view
 */
export async function cmdRefreshRole(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider): Promise<void> {
  databaseTreeProvider?.refresh(item);
}
