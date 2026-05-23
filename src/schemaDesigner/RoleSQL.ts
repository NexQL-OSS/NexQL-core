export type RolePrivilegeFlag =
  | 'login'
  | 'superuser'
  | 'createdb'
  | 'createrole'
  | 'inherit'
  | 'replication'
  | 'bypassrls';

export interface RoleDesignerDatabasePrivilege {
  databaseName: string;
  connect: boolean;
  create: boolean;
  temp: boolean;
}

export interface RoleDesignerSchemaPrivilege {
  schemaName: string;
  usage: boolean;
  create: boolean;
  selectAllTables: boolean;
}

export interface RoleDesignerTablePrivilege {
  schemaName: string;
  tableName: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
}

export interface RoleDesignerDefaultTablePrivilege {
  schemaName: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
}

export interface RoleDesignerMembership {
  roleName: string;
  enabled: boolean;
  lastLogin?: string | null;
  privilegeType?: 'inherit' | 'admin'; // inherit = basic, admin = WITH ADMIN OPTION
}

export interface RoleDesignerState {
  roleName: string;
  password: string;
  connectionLimit: string;
  validUntil: string;
  flags: Record<RolePrivilegeFlag, boolean>;
  searchPath: string;
  statementTimeout: string;
  workMem: string;
  databasePrivileges: RoleDesignerDatabasePrivilege[];
  schemaPrivileges: RoleDesignerSchemaPrivilege[];
  defaultTablePrivileges: RoleDesignerDefaultTablePrivilege[];
  tablePrivileges: RoleDesignerTablePrivilege[];
  memberOf: RoleDesignerMembership[];
  members: RoleDesignerMembership[];
  availableRoles: string[]; // List of all available roles for dropdown
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function joinStatements(statements: string[]): string {
  return statements.filter(Boolean).join('\n\n');
}

function formatConnectionLimit(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? '-1' : trimmed;
}

function normalizeSearchPath(searchPath: string): string {
  return searchPath
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .join(', ');
}

function renderRoleWithClause(state: RoleDesignerState): string {
  const parts: string[] = [state.flags.login ? 'LOGIN' : 'NOLOGIN'];
  parts.push(state.flags.superuser ? 'SUPERUSER' : 'NOSUPERUSER');
  parts.push(state.flags.createdb ? 'CREATEDB' : 'NOCREATEDB');
  parts.push(state.flags.createrole ? 'CREATEROLE' : 'NOCREATEROLE');
  parts.push(state.flags.inherit ? 'INHERIT' : 'NOINHERIT');
  parts.push(state.flags.replication ? 'REPLICATION' : 'NOREPLICATION');
  parts.push(state.flags.bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS');
  parts.push(`CONNECTION LIMIT ${formatConnectionLimit(state.connectionLimit)}`);
  return parts.join('\n  ');
}

function renderPropertyStatements(state: RoleDesignerState): string[] {
  const role = quoteIdent(state.roleName);
  const statements: string[] = [];

  statements.push(`ALTER ROLE ${role}\n  WITH ${renderRoleWithClause(state)};`);

  if (state.validUntil.trim()) {
    statements.push(`ALTER ROLE ${role}\n  VALID UNTIL ${quoteLiteral(state.validUntil.trim())};`);
  } else {
    statements.push(`ALTER ROLE ${role}\n  VALID UNTIL 'infinity';`);
  }

  if (state.searchPath.trim()) {
    statements.push(`ALTER ROLE ${role}\n  SET search_path TO ${normalizeSearchPath(state.searchPath)};`);
  }

  if (state.statementTimeout.trim()) {
    statements.push(`ALTER ROLE ${role}\n  SET statement_timeout TO ${quoteLiteral(state.statementTimeout.trim())};`);
  }

  if (state.workMem.trim()) {
    statements.push(`ALTER ROLE ${role}\n  SET work_mem TO ${quoteLiteral(state.workMem.trim())};`);
  }

  return statements;
}

function renderDatabasePrivilegeStatements(state: RoleDesignerState): string[] {
  const role = quoteIdent(state.roleName);
  const statements: string[] = [];

  for (const row of state.databasePrivileges) {
    const granted: string[] = [];
    const revoked: string[] = [];

    if (row.connect) granted.push('CONNECT'); else revoked.push('CONNECT');
    if (row.create) granted.push('CREATE'); else revoked.push('CREATE');
    if (row.temp) granted.push('TEMP'); else revoked.push('TEMP');

    if (granted.length > 0) {
      statements.push(`GRANT ${granted.join(', ')} ON DATABASE ${quoteIdent(row.databaseName)} TO ${role};`);
    }
    if (revoked.length > 0) {
      statements.push(`REVOKE ${revoked.join(', ')} ON DATABASE ${quoteIdent(row.databaseName)} FROM ${role};`);
    }
  }

  return statements;
}

function renderSchemaPrivilegeStatements(state: RoleDesignerState): string[] {
  const role = quoteIdent(state.roleName);
  const statements: string[] = [];

  for (const row of state.schemaPrivileges) {
    if (row.usage) {
      statements.push(`GRANT USAGE ON SCHEMA ${quoteIdent(row.schemaName)} TO ${role};`);
    } else {
      statements.push(`REVOKE USAGE ON SCHEMA ${quoteIdent(row.schemaName)} FROM ${role};`);
    }

    if (row.create) {
      statements.push(`GRANT CREATE ON SCHEMA ${quoteIdent(row.schemaName)} TO ${role};`);
    } else {
      statements.push(`REVOKE CREATE ON SCHEMA ${quoteIdent(row.schemaName)} FROM ${role};`);
    }

    if (row.selectAllTables) {
      statements.push(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(row.schemaName)} TO ${role};`);
    } else {
      statements.push(`REVOKE SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(row.schemaName)} FROM ${role};`);
    }
  }

  return statements;
}

function renderDefaultTablePrivilegeStatements(state: RoleDesignerState): string[] {
  const role = quoteIdent(state.roleName);
  const statements: string[] = [];

  for (const row of state.defaultTablePrivileges) {
    const granted: string[] = [];

    if (row.select) granted.push('SELECT');
    if (row.insert) granted.push('INSERT');
    if (row.update) granted.push('UPDATE');
    if (row.delete) granted.push('DELETE');

    if (granted.length > 0) {
      statements.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(row.schemaName)} GRANT ${granted.join(', ')} ON TABLES TO ${role};`);
    }
  }

  return statements;
}

function renderTablePrivilegeStatements(state: RoleDesignerState): string[] {
  const role = quoteIdent(state.roleName);
  const statements: string[] = [];

  for (const row of state.tablePrivileges) {
    const tableName = `${quoteIdent(row.schemaName)}.${quoteIdent(row.tableName)}`;
    const granted: string[] = [];
    const revoked: string[] = [];

    if (row.select) granted.push('SELECT'); else revoked.push('SELECT');
    if (row.insert) granted.push('INSERT'); else revoked.push('INSERT');
    if (row.update) granted.push('UPDATE'); else revoked.push('UPDATE');
    if (row.delete) granted.push('DELETE'); else revoked.push('DELETE');

    if (granted.length > 0) {
      statements.push(`GRANT ${granted.join(', ')} ON TABLE ${tableName} TO ${role};`);
    }
    if (revoked.length > 0) {
      statements.push(`REVOKE ${revoked.join(', ')} ON TABLE ${tableName} FROM ${role};`);
    }
  }

  return statements;
}

function renderMembershipStatements(roleName: string, memberships: RoleDesignerMembership[], direction: 'memberOf' | 'members'): string[] {
  const statements: string[] = [];
  const role = quoteIdent(roleName);

  for (const membership of memberships) {
    const targetRole = quoteIdent(membership.roleName);
    if (direction === 'memberOf') {
      statements.push(
        membership.enabled
          ? `GRANT ${targetRole} TO ${role};`
          : `REVOKE ${targetRole} FROM ${role};`
      );
    } else {
      statements.push(
        membership.enabled
          ? `GRANT ${role} TO ${targetRole};`
          : `REVOKE ${role} FROM ${targetRole};`
      );
    }
  }

  return statements;
}

export function buildRoleMigrationStatements(state: RoleDesignerState): string[] {
  return [
    '-- Generated by PgStudio Role Designer',
    '-- Review carefully before executing in a transaction',
    '',
    ...renderPropertyStatements(state),
    ...renderDatabasePrivilegeStatements(state),
    ...renderSchemaPrivilegeStatements(state),
    ...renderDefaultTablePrivilegeStatements(state),
    ...renderTablePrivilegeStatements(state),
    ...renderMembershipStatements(state.roleName, state.memberOf, 'memberOf'),
    ...renderMembershipStatements(state.roleName, state.members, 'members'),
  ];
}

export function buildRoleMigrationSql(state: RoleDesignerState): string {
  const statements = buildRoleMigrationStatements(state);
  return ['BEGIN;', '', joinStatements(statements), '', 'COMMIT;'].join('\n');
}

export function buildRoleMigrationMarkdown(state: RoleDesignerState): string {
  const statementCount = buildRoleMigrationStatements(state).filter(line => !line.startsWith('--') && line.trim() !== '').length;
  return `### Role Designer: \`${state.roleName}\`\n\n` +
    `<div style="font-size:12px;background:rgba(52,152,219,0.1);border-left:3px solid #3498db;padding:6px 10px;margin-bottom:15px;border-radius:3px;">` +
    `<strong>ℹ️ Review:</strong> This script is generated from the current visual state. Run it in a transaction for safety.</div>\n\n` +
    `Generated **${statementCount}** SQL statement(s).`;
}

export function buildRolePreviewHtml(state: RoleDesignerState): string {
  const sql = buildRoleMigrationSql(state)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<span class="cm">-- Generated by PgStudio Role Designer</span><br>` +
    `<span class="cm">-- Review carefully before executing in a transaction</span><br><br>` +
    sql.replace(/\n/g, '<br>').replace(/  /g, '&nbsp;&nbsp;');
}

// Delta detection and generation for incremental preview
function getPropertyChanges(original: RoleDesignerState, current: RoleDesignerState): string[] {
  const role = quoteIdent(current.roleName);
  const statements: string[] = [];

  // Check if any WITH clause flags changed
  const flagsChanged = Object.keys(current.flags).some(
    flag => current.flags[flag as RolePrivilegeFlag] !== original.flags[flag as RolePrivilegeFlag]
  );
  if (flagsChanged) {
    statements.push(`ALTER ROLE ${role}\n  WITH ${renderRoleWithClause(current)};`);
  }

  // Check VALID UNTIL
  const validUntilChanged = current.validUntil.trim() !== original.validUntil.trim();
  if (validUntilChanged) {
    const validUntil = current.validUntil.trim() ? quoteLiteral(current.validUntil.trim()) : "'infinity'";
    statements.push(`ALTER ROLE ${role}\n  VALID UNTIL ${validUntil};`);
  }

  // Check search_path
  const searchPathChanged = normalizeSearchPath(current.searchPath) !== normalizeSearchPath(original.searchPath);
  if (searchPathChanged) {
    if (current.searchPath.trim()) {
      statements.push(`ALTER ROLE ${role}\n  SET search_path TO ${normalizeSearchPath(current.searchPath)};`);
    } else {
      statements.push(`ALTER ROLE ${role}\n  RESET search_path;`);
    }
  }

  // Check statement_timeout
  const statementTimeoutChanged = current.statementTimeout.trim() !== original.statementTimeout.trim();
  if (statementTimeoutChanged) {
    if (current.statementTimeout.trim()) {
      statements.push(`ALTER ROLE ${role}\n  SET statement_timeout TO ${quoteLiteral(current.statementTimeout.trim())};`);
    } else {
      statements.push(`ALTER ROLE ${role}\n  RESET statement_timeout;`);
    }
  }

  // Check work_mem
  const workMemChanged = current.workMem.trim() !== original.workMem.trim();
  if (workMemChanged) {
    if (current.workMem.trim()) {
      statements.push(`ALTER ROLE ${role}\n  SET work_mem TO ${quoteLiteral(current.workMem.trim())};`);
    } else {
      statements.push(`ALTER ROLE ${role}\n  RESET work_mem;`);
    }
  }

  return statements;
}

function getDatabasePrivilegeChanges(original: RoleDesignerState, current: RoleDesignerState): string[] {
  const role = quoteIdent(current.roleName);
  const statements: string[] = [];

  const currentMap = new Map(current.databasePrivileges.map(p => [p.databaseName, p]));
  const originalMap = new Map(original.databasePrivileges.map(p => [p.databaseName, p]));

  const allDbNames = new Set([...currentMap.keys(), ...originalMap.keys()]);

  for (const dbName of allDbNames) {
    const currPriv = currentMap.get(dbName);
    const origPriv = originalMap.get(dbName);

    if (!currPriv && origPriv) {
      // Database privilege was removed
      const revoked: string[] = [];
      if (origPriv.connect) revoked.push('CONNECT');
      if (origPriv.create) revoked.push('CREATE');
      if (origPriv.temp) revoked.push('TEMP');
      if (revoked.length > 0) {
        statements.push(`REVOKE ${revoked.join(', ')} ON DATABASE ${quoteIdent(dbName)} FROM ${role};`);
      }
    } else if (currPriv && !origPriv) {
      // Database privilege was added
      const granted: string[] = [];
      if (currPriv.connect) granted.push('CONNECT');
      if (currPriv.create) granted.push('CREATE');
      if (currPriv.temp) granted.push('TEMP');
      if (granted.length > 0) {
        statements.push(`GRANT ${granted.join(', ')} ON DATABASE ${quoteIdent(dbName)} TO ${role};`);
      }
    } else if (currPriv && origPriv) {
      // Database privilege exists in both, check for changes
      const granted: string[] = [];
      const revoked: string[] = [];

      // CONNECT
      if (currPriv.connect && !origPriv.connect) granted.push('CONNECT');
      if (!currPriv.connect && origPriv.connect) revoked.push('CONNECT');

      // CREATE
      if (currPriv.create && !origPriv.create) granted.push('CREATE');
      if (!currPriv.create && origPriv.create) revoked.push('CREATE');

      // TEMP
      if (currPriv.temp && !origPriv.temp) granted.push('TEMP');
      if (!currPriv.temp && origPriv.temp) revoked.push('TEMP');

      if (granted.length > 0) {
        statements.push(`GRANT ${granted.join(', ')} ON DATABASE ${quoteIdent(dbName)} TO ${role};`);
      }
      if (revoked.length > 0) {
        statements.push(`REVOKE ${revoked.join(', ')} ON DATABASE ${quoteIdent(dbName)} FROM ${role};`);
      }
    }
  }

  return statements;
}

function getSchemaPrivilegeChanges(original: RoleDesignerState, current: RoleDesignerState): string[] {
  const role = quoteIdent(current.roleName);
  const statements: string[] = [];

  const currentMap = new Map(current.schemaPrivileges.map(p => [p.schemaName, p]));
  const originalMap = new Map(original.schemaPrivileges.map(p => [p.schemaName, p]));

  const allSchemaNames = new Set([...currentMap.keys(), ...originalMap.keys()]);

  for (const schemaName of allSchemaNames) {
    const currPriv = currentMap.get(schemaName);
    const origPriv = originalMap.get(schemaName);

    if (!currPriv && origPriv) {
      // Schema privilege was removed
      if (origPriv.usage) {
        statements.push(`REVOKE USAGE ON SCHEMA ${quoteIdent(schemaName)} FROM ${role};`);
      }
      if (origPriv.create) {
        statements.push(`REVOKE CREATE ON SCHEMA ${quoteIdent(schemaName)} FROM ${role};`);
      }
      if (origPriv.selectAllTables) {
        statements.push(`REVOKE SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} FROM ${role};`);
      }
    } else if (currPriv && !origPriv) {
      // Schema privilege was added
      if (currPriv.usage) {
        statements.push(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${role};`);
      }
      if (currPriv.create) {
        statements.push(`GRANT CREATE ON SCHEMA ${quoteIdent(schemaName)} TO ${role};`);
      }
      if (currPriv.selectAllTables) {
        statements.push(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} TO ${role};`);
      }
    } else if (currPriv && origPriv) {
      // Schema privilege exists in both, check for changes
      // USAGE
      if (currPriv.usage && !origPriv.usage) {
        statements.push(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${role};`);
      } else if (!currPriv.usage && origPriv.usage) {
        statements.push(`REVOKE USAGE ON SCHEMA ${quoteIdent(schemaName)} FROM ${role};`);
      }

      // CREATE
      if (currPriv.create && !origPriv.create) {
        statements.push(`GRANT CREATE ON SCHEMA ${quoteIdent(schemaName)} TO ${role};`);
      } else if (!currPriv.create && origPriv.create) {
        statements.push(`REVOKE CREATE ON SCHEMA ${quoteIdent(schemaName)} FROM ${role};`);
      }

      // SELECT ALL TABLES
      if (currPriv.selectAllTables && !origPriv.selectAllTables) {
        statements.push(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} TO ${role};`);
      } else if (!currPriv.selectAllTables && origPriv.selectAllTables) {
        statements.push(`REVOKE SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} FROM ${role};`);
      }
    }
  }

  return statements;
}

function getDefaultTablePrivilegeChanges(original: RoleDesignerState, current: RoleDesignerState): string[] {
  const role = quoteIdent(current.roleName);
  const statements: string[] = [];

  const currentMap = new Map(current.defaultTablePrivileges.map(p => [p.schemaName, p]));
  const originalMap = new Map(original.defaultTablePrivileges.map(p => [p.schemaName, p]));

  const allSchemaNames = new Set([...currentMap.keys(), ...originalMap.keys()]);

  for (const schemaName of allSchemaNames) {
    const currPriv = currentMap.get(schemaName);
    const origPriv = originalMap.get(schemaName);

    if (!currPriv && origPriv) {
      // Default table privilege was removed
      const revoked: string[] = [];
      if (origPriv.select) revoked.push('SELECT');
      if (origPriv.insert) revoked.push('INSERT');
      if (origPriv.update) revoked.push('UPDATE');
      if (origPriv.delete) revoked.push('DELETE');
      if (revoked.length > 0) {
        statements.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)} REVOKE ${revoked.join(', ')} ON TABLES FROM ${role};`);
      }
    } else if (currPriv && !origPriv) {
      // Default table privilege was added
      const granted: string[] = [];
      if (currPriv.select) granted.push('SELECT');
      if (currPriv.insert) granted.push('INSERT');
      if (currPriv.update) granted.push('UPDATE');
      if (currPriv.delete) granted.push('DELETE');
      if (granted.length > 0) {
        statements.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)} GRANT ${granted.join(', ')} ON TABLES TO ${role};`);
      }
    } else if (currPriv && origPriv) {
      // Default table privilege exists in both, check for changes
      const granted: string[] = [];
      const revoked: string[] = [];

      if (currPriv.select && !origPriv.select) granted.push('SELECT');
      if (!currPriv.select && origPriv.select) revoked.push('SELECT');

      if (currPriv.insert && !origPriv.insert) granted.push('INSERT');
      if (!currPriv.insert && origPriv.insert) revoked.push('INSERT');

      if (currPriv.update && !origPriv.update) granted.push('UPDATE');
      if (!currPriv.update && origPriv.update) revoked.push('UPDATE');

      if (currPriv.delete && !origPriv.delete) granted.push('DELETE');
      if (!currPriv.delete && origPriv.delete) revoked.push('DELETE');

      if (granted.length > 0) {
        statements.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)} GRANT ${granted.join(', ')} ON TABLES TO ${role};`);
      }
      if (revoked.length > 0) {
        statements.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)} REVOKE ${revoked.join(', ')} ON TABLES FROM ${role};`);
      }
    }
  }

  return statements;
}

function getTablePrivilegeChanges(original: RoleDesignerState, current: RoleDesignerState): string[] {
  const role = quoteIdent(current.roleName);
  const statements: string[] = [];

  const currentMap = new Map(
    current.tablePrivileges.map(p => [`${p.schemaName}.${p.tableName}`, p])
  );
  const originalMap = new Map(
    original.tablePrivileges.map(p => [`${p.schemaName}.${p.tableName}`, p])
  );

  const allTableKeys = new Set([...currentMap.keys(), ...originalMap.keys()]);

  for (const key of allTableKeys) {
    const currPriv = currentMap.get(key);
    const origPriv = originalMap.get(key);

    if (!currPriv && origPriv) {
      // Table privilege was removed
      const tableName = `${quoteIdent(origPriv.schemaName)}.${quoteIdent(origPriv.tableName)}`;
      const revoked: string[] = [];
      if (origPriv.select) revoked.push('SELECT');
      if (origPriv.insert) revoked.push('INSERT');
      if (origPriv.update) revoked.push('UPDATE');
      if (origPriv.delete) revoked.push('DELETE');
      if (revoked.length > 0) {
        statements.push(`REVOKE ${revoked.join(', ')} ON TABLE ${tableName} FROM ${role};`);
      }
    } else if (currPriv && !origPriv) {
      // Table privilege was added
      const tableName = `${quoteIdent(currPriv.schemaName)}.${quoteIdent(currPriv.tableName)}`;
      const granted: string[] = [];
      if (currPriv.select) granted.push('SELECT');
      if (currPriv.insert) granted.push('INSERT');
      if (currPriv.update) granted.push('UPDATE');
      if (currPriv.delete) granted.push('DELETE');
      if (granted.length > 0) {
        statements.push(`GRANT ${granted.join(', ')} ON TABLE ${tableName} TO ${role};`);
      }
    } else if (currPriv && origPriv) {
      // Table privilege exists in both, check for changes
      const tableName = `${quoteIdent(currPriv.schemaName)}.${quoteIdent(currPriv.tableName)}`;
      const granted: string[] = [];
      const revoked: string[] = [];

      if (currPriv.select && !origPriv.select) granted.push('SELECT');
      if (!currPriv.select && origPriv.select) revoked.push('SELECT');

      if (currPriv.insert && !origPriv.insert) granted.push('INSERT');
      if (!currPriv.insert && origPriv.insert) revoked.push('INSERT');

      if (currPriv.update && !origPriv.update) granted.push('UPDATE');
      if (!currPriv.update && origPriv.update) revoked.push('UPDATE');

      if (currPriv.delete && !origPriv.delete) granted.push('DELETE');
      if (!currPriv.delete && origPriv.delete) revoked.push('DELETE');

      if (granted.length > 0) {
        statements.push(`GRANT ${granted.join(', ')} ON TABLE ${tableName} TO ${role};`);
      }
      if (revoked.length > 0) {
        statements.push(`REVOKE ${revoked.join(', ')} ON TABLE ${tableName} FROM ${role};`);
      }
    }
  }

  return statements;
}

function getMembershipChanges(
  roleName: string,
  original: RoleDesignerMembership[],
  current: RoleDesignerMembership[],
  direction: 'memberOf' | 'members'
): string[] {
  const statements: string[] = [];
  const role = quoteIdent(roleName);

  // Create maps keyed by roleName
  const currentMap = new Map(current.map(m => [m.roleName, m]));
  const originalMap = new Map(original.map(m => [m.roleName, m]));

  const allMemberRoles = new Set([...currentMap.keys(), ...originalMap.keys()]);

  for (const memberRole of allMemberRoles) {
    const currMembership = currentMap.get(memberRole);
    const origMembership = originalMap.get(memberRole);
    const targetRole = quoteIdent(memberRole);

    if (!currMembership && origMembership) {
      // Membership was removed
      if (origMembership.enabled) {
        if (direction === 'memberOf') {
          statements.push(`REVOKE ${targetRole} FROM ${role};`);
        } else {
          statements.push(`REVOKE ${role} FROM ${targetRole};`);
        }
      }
    } else if (currMembership && !origMembership) {
      // Membership was added
      if (currMembership.enabled) {
        const adminOpt = currMembership.privilegeType === 'admin' ? ' WITH ADMIN OPTION' : '';
        if (direction === 'memberOf') {
          statements.push(`GRANT ${targetRole} TO ${role}${adminOpt};`);
        } else {
          statements.push(`GRANT ${role} TO ${targetRole}${adminOpt};`);
        }
      }
    } else if (currMembership && origMembership) {
      // Membership exists in both, check for changes
      const currEnabled = currMembership.enabled;
      const origEnabled = origMembership.enabled;
      const currPrivType = currMembership.privilegeType || 'inherit';
      const origPrivType = origMembership.privilegeType || 'inherit';

      if (currEnabled && !origEnabled) {
        // Changed from revoked to granted
        const adminOpt = currPrivType === 'admin' ? ' WITH ADMIN OPTION' : '';
        if (direction === 'memberOf') {
          statements.push(`GRANT ${targetRole} TO ${role}${adminOpt};`);
        } else {
          statements.push(`GRANT ${role} TO ${targetRole}${adminOpt};`);
        }
      } else if (!currEnabled && origEnabled) {
        // Changed from granted to revoked
        if (direction === 'memberOf') {
          statements.push(`REVOKE ${targetRole} FROM ${role};`);
        } else {
          statements.push(`REVOKE ${role} FROM ${targetRole};`);
        }
      } else if (currEnabled && origEnabled && currPrivType !== origPrivType) {
        // Privilege type changed while enabled
        // Need to revoke and re-grant with new option
        if (direction === 'memberOf') {
          statements.push(`REVOKE ${targetRole} FROM ${role};`);
          const adminOpt = currPrivType === 'admin' ? ' WITH ADMIN OPTION' : '';
          statements.push(`GRANT ${targetRole} TO ${role}${adminOpt};`);
        } else {
          statements.push(`REVOKE ${role} FROM ${targetRole};`);
          const adminOpt = currPrivType === 'admin' ? ' WITH ADMIN OPTION' : '';
          statements.push(`GRANT ${role} TO ${targetRole}${adminOpt};`);
        }
      }
    }
  }

  return statements;
}

export function buildRoleChangeStatements(
  original: RoleDesignerState,
  current: RoleDesignerState
): string[] {
  if (!original) {
    return buildRoleMigrationStatements(current);
  }

  const statements: string[] = [];

  statements.push('-- Changes made to role');
  if (statements.length === 0 || statements[statements.length - 1].trim()) {
    // Only add comment if not empty
  }

  statements.push(...getPropertyChanges(original, current));
  statements.push(...getDatabasePrivilegeChanges(original, current));
  statements.push(...getSchemaPrivilegeChanges(original, current));
  statements.push(...getDefaultTablePrivilegeChanges(original, current));
  statements.push(...getTablePrivilegeChanges(original, current));
  statements.push(...getMembershipChanges(current.roleName, original.memberOf, current.memberOf, 'memberOf'));
  statements.push(...getMembershipChanges(current.roleName, original.members, current.members, 'members'));

  return statements.filter(Boolean);
}

export function buildRoleChangePreviewHtml(original: RoleDesignerState, current: RoleDesignerState): string {
  const statements = buildRoleChangeStatements(original, current);

  if (statements.length === 0) {
    return '<span class="cm" style="color: var(--muted);">-- No changes detected</span>';
  }

  const sql = statements
    .join('\n\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<span class="cm">-- Changes made to role</span><br><br>` +
    sql.replace(/\n/g, '<br>').replace(/  /g, '&nbsp;&nbsp;');
}

export function buildRoleChangeMigrationSql(
  original: RoleDesignerState,
  current: RoleDesignerState
): string {
  const statements = buildRoleChangeStatements(original, current);
  return ['BEGIN;', '', joinStatements(statements), '', 'COMMIT;'].join('\n');
}

export function buildRoleChangeMigrationMarkdown(
  original: RoleDesignerState,
  current: RoleDesignerState
): string {
  const statements = buildRoleChangeStatements(original, current);
  const statementCount = statements.filter(line => !line.startsWith('--') && line.trim() !== '').length;

  return `### Role Designer Changes: \`${current.roleName}\`\n\n` +
    `<div style="font-size:12px;background:rgba(52,152,219,0.1);border-left:3px solid #3498db;padding:6px 10px;margin-bottom:15px;border-radius:3px;">` +
    `<strong>ℹ️ Delta Mode:</strong> This script contains only the modifications to the role configuration. Run it in a transaction for safety.</div>\n\n` +
    `Generated **${statementCount}** SQL statement(s).`;
}
