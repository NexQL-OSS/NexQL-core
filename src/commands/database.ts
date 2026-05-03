import { Client } from 'pg';
import * as vscode from 'vscode';
import { createMetadata, getConnectionWithPassword } from '../commands/connection';
import { ConnectionConfig } from '../common/types';
import { DashboardPanel } from '../dashboard/DashboardPanel';
import { DatabaseTreeItem, DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { ConnectionManager } from '../services/ConnectionManager';
import {
  MarkdownUtils,
  ErrorHandlers,
  getDatabaseConnection,
  NotebookBuilder,
  QueryBuilder,
  MaintenanceTemplates,
  validateCategoryItem
} from './helper';
import { openOrCreateNotebookWithPicker } from './notebook';
import { BackupRestorePanel } from '../features/backup/BackupRestorePanel';



/**
 * cmdShowDatabaseDashboard - Creates a notebook with database statistics and performance metrics.
 * Shows:
 * - Database size and general statistics
 * - Table sizes and row counts
 * - Index usage statistics
 * - Cache hit ratios
 * 
 * @param {DatabaseTreeItem} item - The selected database item from the tree view
 * @param {vscode.ExtensionContext} context - The extension context
 * @returns {Promise<void>} - A promise that resolves when the dashboard is displayed
 * 
 * @example
 * await cmdShowDatabaseDashboard(databaseItem, context);
 * // Dashboard notebook is now displayed
 */
export async function cmdDatabaseDashboard(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  try {
    const { connection, release } = await getDatabaseConnection(item, validateCategoryItem);
    // Release the client used for validation/setup immediately
    release();

    await DashboardPanel.show(context.extensionUri, connection, item.databaseName!, connection.id);
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show dashboard');
  }
}

/**
 * Command Palette: pick saved connection → database, then open the live dashboard webview.
 */
export async function cmdDatabaseDashboardFromPalette(
  context: vscode.ExtensionContext,
): Promise<void> {
  const connections =
    vscode.workspace
      .getConfiguration()
      .get<Array<Record<string, unknown>>>('postgresExplorer.connections') || [];
  if (connections.length === 0) {
    await vscode.window.showErrorMessage(
      'No saved connections. Add a connection first.',
    );
    return;
  }

  const connPick = await vscode.window.showQuickPick(
    connections.map((c: Record<string, unknown>) => ({
      label: (c.name as string) || `${c.host}:${c.port}`,
      description: (c.database as string) || 'postgres',
      conn: c,
    })),
    {
      title: 'Live Dashboard: Connection',
      placeHolder: 'Select a saved connection',
    },
  );
  if (!connPick) {
    return;
  }

  const connection = connPick.conn as Record<string, unknown> & {
    id: string;
    host: string;
    port: number;
    database?: string;
  };
  const bootstrapDb = connection.database || 'postgres';

  let tempClient;
  try {
    tempClient = await ConnectionManager.getInstance().getPooledClient({
      ...(connection as ConnectionConfig),
      database: bootstrapDb,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(`Could not connect: ${msg}`);
    return;
  }

  let dbName: string;
  try {
    const dbsResult = await tempClient.query(`
      SELECT datname FROM pg_database
      WHERE datallowconn = true AND datistemplate = false
      ORDER BY datname
    `);
    const databases = dbsResult.rows.map((r: { datname: string }) => r.datname);
    const dbChoice = await vscode.window.showQuickPick(databases, {
      title: 'Live Dashboard: Database',
      placeHolder: 'Database to open the dashboard for',
    });
    if (!dbChoice) {
      return;
    }
    dbName = dbChoice;
  } finally {
    tempClient.release();
  }

  try {
    await DashboardPanel.show(
      context.extensionUri,
      connection as ConnectionConfig,
      dbName,
      connection.id,
    );
  } catch (err: unknown) {
    await ErrorHandlers.handleCommandError(err, 'show dashboard');
  }
}

/**
 * cmdAddInDatabase - Command to create a new object in the database.
 * Prompts the user to select the type of object to create (schema, user, role, or extension).
 * Creates a notebook with a template for the selected object type.
 * 
 * @param {DatabaseTreeItem} item - The selected database item from the tree view
 * @param {vscode.ExtensionContext} context - The extension context
 */
export async function cmdAddObjectInDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  try {
    const dbConn = await getDatabaseConnection(item, validateCategoryItem);
    const { metadata } = dbConn;
    // Release immediately as we only needed metadata/validation
    if (dbConn.release) dbConn.release();

    const items = [
      { label: 'Schema', detail: 'Create a new schema in this database' },
      { label: 'User', detail: 'Create a new user with login privileges' },
      { label: 'Role', detail: 'Create a new role' },
      { label: 'Extension', detail: 'Enable a PostgreSQL extension' }
    ];

    const selection = await vscode.window.showQuickPick(items, {
      title: 'Create in Database',
      placeHolder: 'Select what to create'
    });

    if (selection) {
      const builder = new NotebookBuilder(metadata);

      if (selection.label === 'Schema') {
        builder.addMarkdown(
          MarkdownUtils.header('📂 Create New Schema') +
          MarkdownUtils.infoBox('This notebook guides you through creating a new PostgreSQL schema and configuring permissions. Schemas help organize database objects and control access.') +
          `\n\n#### 🎯 What is a Schema?\n\n` +
          `A schema is a named collection of database objects (tables, views, functions) that:\n` +
          `- 📦 Organizes objects logically\n` +
          `- 🔐 Controls access at the schema level\n` +
          `- 🏗️ Prevents naming conflicts\n` +
          `- 👥 Supports multi-tenant applications\n\n` +
          MarkdownUtils.successBox('Execute cells in order. Skip optional sections if not needed for your use case.')
        )
          .addMarkdown(`#### 1. Create Schema\nCreate a new schema with optional ownership settings.`)
          .addMarkdown(`##### 📝 Schema Definition`)
          .addSql(`-- Basic schema creation
CREATE SCHEMA schema_name;

-- OR create with specific owner
-- CREATE SCHEMA schema_name AUTHORIZATION role_name;`)
          .addMarkdown(`#### 2. Basic Permissions\nGrant basic usage permissions to roles that need to access the schema.`)
          .addMarkdown(`##### 🛡️ Grant Usage`)
          .addSql(`-- Grant basic schema usage
GRANT USAGE ON SCHEMA schema_name TO role_name;`)
          .addMarkdown(`#### 3. Object Permissions\nGrant permissions for existing tables and sequences in the schema.`)
          .addMarkdown(`##### 🔐 Object Privileges`)
          .addSql(`-- Grant permissions on all tables
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA schema_name TO role_name;

-- Grant permissions on all sequences
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA schema_name TO role_name;`)
          .addMarkdown(`#### 4. Default Privileges\nSet up default privileges for objects that will be created in the future.`)
          .addMarkdown(`##### 🔮 Future Objects`)
          .addSql(`-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA schema_name
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO role_name;

-- Set default privileges for future sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA schema_name
    GRANT USAGE, SELECT ON SEQUENCES TO role_name;`)
          .addMarkdown(`#### Example: Complete Schema Setup\nHere's a practical example of creating an application schema with specific privileges.`)
          .addMarkdown(`##### 🚀 Full Example`)
          .addSql(`-- Example: Create application schema with specific privileges
CREATE SCHEMA app_schema;

-- Grant read-only access to app_readonly role
GRANT USAGE ON SCHEMA app_schema TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA app_schema TO app_readonly;

-- Grant full access to app_admin role
GRANT ALL PRIVILEGES ON SCHEMA app_schema TO app_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app_schema TO app_admin;`);

      } else if (selection.label === 'User') {
        builder.addMarkdown(
          MarkdownUtils.header('👤 Create New Database User') +
          MarkdownUtils.infoBox('Create a new PostgreSQL user with login capabilities and configure appropriate privileges.') +
          `\n\n#### 🔑 User vs Role\n\n` +
          MarkdownUtils.propertiesTable({
            'Login': '✅ Can login (User) vs ❌ Cannot login (Role)',
            'Purpose': 'Individual access vs Group permissions',
            'Password': 'Required vs Not required',
            'Inheritance': 'Inherits from roles vs Can be granted to users'
          }) +
          `\n\n` +
          MarkdownUtils.dangerBox('Always use strong passwords and follow the principle of least privilege—grant only necessary permissions.', 'IMPORTANT')
        )
          .addMarkdown(`#### 1. Create User\nCreate a new user with basic attributes. Uncomment and modify additional attributes as needed.`)
          .addMarkdown(`##### 👤 User Definition`)
          .addSql(`-- Create new user with basic attributes
CREATE USER username WITH
    LOGIN
    PASSWORD 'strong_password'
    -- Additional optional attributes:
    -- CREATEDB                    -- Can create new databases
    -- SUPERUSER                   -- Has all database privileges
    -- CREATEROLE                  -- Can create new roles
    -- REPLICATION                 -- Can initiate streaming replication
    -- CONNECTION LIMIT 5          -- Maximum concurrent connections
    -- VALID UNTIL '2025-12-31'   -- Password expiration date
;`)
          .addMarkdown(`#### 2. Database Privileges\nGrant database-level privileges to the new user.`)
          .addMarkdown(`##### 🗄️ Database Access`)
          .addSql(`-- Grant database connection privileges
GRANT CONNECT ON DATABASE database_name TO username;

-- Allow creating temporary tables
GRANT TEMP ON DATABASE database_name TO username;`)
          .addMarkdown(`#### 3. Schema Privileges\nGrant schema-level privileges. Repeat for each schema as needed.`)
          .addMarkdown(`##### 📂 Schema Access`)
          .addSql(`-- Grant schema privileges
GRANT USAGE ON SCHEMA schema_name TO username;

-- Optional: allow creating new objects in schema
-- GRANT CREATE ON SCHEMA schema_name TO username;`)
          .addMarkdown(`#### 4. Table Privileges\nGrant table-level privileges within schemas.`)
          .addMarkdown(`##### 📊 Table Access`)
          .addSql(`-- Grant table privileges
GRANT SELECT, INSERT, UPDATE, DELETE 
ON ALL TABLES IN SCHEMA schema_name 
TO username;`)
          .addMarkdown(`#### 5. Default Privileges\nSet up default privileges for future objects.`)
          .addMarkdown(`##### 🔮 Future Objects`)
          .addSql(`-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA schema_name
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
TO username;`)
          .addMarkdown(`#### Example: Read-only User\nHere's a practical example of creating a read-only user.`)
          .addMarkdown(`##### 👓 Read-Only Example`)
          .addSql(`-- Create read-only user
CREATE USER readonly_user WITH
    LOGIN
    PASSWORD 'strong_password'
    CONNECTION LIMIT 10;

-- Grant minimal privileges
GRANT CONNECT ON DATABASE database_name TO readonly_user;
GRANT USAGE ON SCHEMA public TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;

-- Set up default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO readonly_user;`);

      } else if (selection.label === 'Role') {
        builder.addMarkdown(
          MarkdownUtils.header('👥 Create New Role') +
          MarkdownUtils.infoBox('Roles are used to group permissions. Users can be added to roles to inherit their privileges.') +
          `\n\n#### 🎯 Common Role Patterns\n\n` +
          MarkdownUtils.operationsTable([
            { operation: 'Readonly', description: 'SELECT only (Reporting, analytics)' },
            { operation: 'Read-Write', description: 'SELECT, INSERT, UPDATE, DELETE (Application access)' },
            { operation: 'Admin', description: 'ALL PRIVILEGES (Database administration)' },
            { operation: 'App Role', description: 'Custom based on needs (Service accounts)' }
          ]) +
          `\n\n` +
          MarkdownUtils.successBox('Tip: Create roles for job functions, not individuals. Grant roles to users for easier permission management.')
        )
          .addMarkdown(`#### 1. Create Role\nCreate a new role with basic attributes. Uncomment and modify additional attributes as needed.`)
          .addMarkdown(`##### 🎭 Role Definition`)
          .addSql(`-- Create new role with basic attributes
CREATE ROLE role_name WITH
    NOLOGIN                     -- Cannot login (use LOGIN for login capability)
    INHERIT                     -- Inherit privileges from parent roles
    -- Additional optional attributes:
    -- SUPERUSER               -- Has all database privileges
    -- CREATEDB               -- Can create new databases
    -- CREATEROLE            -- Can create new roles
    -- REPLICATION           -- Can initiate streaming replication
    -- CONNECTION LIMIT 5    -- Maximum concurrent connections
    -- IN GROUP role1, role2 -- Add role to existing groups
;`)
          .addMarkdown(`#### 2. Database Privileges\nGrant database-level privileges to the role.`)
          .addMarkdown(`##### 🗄️ Database Access`)
          .addSql(`-- Grant database privileges
GRANT CONNECT ON DATABASE database_name TO role_name;
GRANT CREATE ON DATABASE database_name TO role_name;`)
          .addMarkdown(`#### 3. Schema Privileges\nGrant schema-level privileges to the role.`)
          .addMarkdown(`##### 📂 Schema Access`)
          .addSql(`-- Grant schema privileges
GRANT USAGE ON SCHEMA schema_name TO role_name;
GRANT CREATE ON SCHEMA schema_name TO role_name;`)
          .addMarkdown(`#### 4. Object Privileges\nGrant privileges on tables, functions, and sequences.`)
          .addMarkdown(`##### 🔐 Object Access`)
          .addSql(`-- Grant table privileges
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA schema_name TO role_name;

-- Grant function privileges
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA schema_name TO role_name;

-- Grant sequence privileges
GRANT USAGE ON ALL SEQUENCES IN SCHEMA schema_name TO role_name;`)
          .addMarkdown(`#### 5. Default Privileges\nSet up default privileges for future objects.`)
          .addMarkdown(`##### 🔮 Future Objects`)
          .addSql(`-- Set default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA schema_name
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO role_name;

ALTER DEFAULT PRIVILEGES IN SCHEMA schema_name
    GRANT EXECUTE ON FUNCTIONS TO role_name;

ALTER DEFAULT PRIVILEGES IN SCHEMA schema_name
    GRANT USAGE ON SEQUENCES TO role_name;`)
          .addMarkdown(`#### Example: Application Role\nHere's a practical example of creating an application role with read-only access.`)
          .addMarkdown(`##### 🚀 App Role Example`)
          .addSql(`-- Create application role
CREATE ROLE app_readonly WITH
    NOLOGIN
    INHERIT
    CONNECTION LIMIT 100;

-- Grant minimal privileges
GRANT CONNECT ON DATABASE app_db TO app_readonly;
GRANT USAGE ON SCHEMA public TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly;

-- Set up default privileges
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO app_readonly;`);

      } else if (selection.label === 'Extension') {
        builder.addMarkdown(
          MarkdownUtils.header('🧩 Enable PostgreSQL Extension') +
          MarkdownUtils.infoBox('PostgreSQL extensions add functionality to your database. Enable only the extensions you need.') +
          `\n\n#### 📦 Popular Extensions\n\n` +
          MarkdownUtils.operationsTable([
            { operation: 'uuid-ossp', description: 'UUID generation (Unique identifiers)' },
            { operation: 'pgcrypto', description: 'Cryptographic functions (Encryption, hashing)' },
            { operation: 'hstore', description: 'Key-value storage (Semi-structured data)' },
            { operation: 'postgis', description: 'Geospatial data (Maps, location data)' },
            { operation: 'pg_stat_statements', description: 'Query statistics (Performance monitoring)' },
            { operation: 'pg_trgm', description: 'Fuzzy text search (Similarity matching)' }
          ]) +
          `\n\n` +
          MarkdownUtils.successBox('Tip: Check if the extension is already installed before enabling it to avoid errors.')
        )
          .addMarkdown(`#### 1. View Available Extensions\nList extensions that can be installed but aren't yet enabled.`)
          .addMarkdown(`##### 🔍 Available Extensions`)
          .addSql(`-- List available extensions
SELECT name as "Name",
       default_version as "Version",
       installed_version as "Installed",
       comment as "Description"
FROM pg_available_extensions 
WHERE installed_version IS NULL 
ORDER BY name;`)
          .addMarkdown(`#### 2. Enable Extension\nEnable a specific extension. Uncomment the extension you want to enable.`)
          .addMarkdown(`##### 🔌 Enable Command`)
          .addSql(`-- Enable your chosen extension
CREATE EXTENSION IF NOT EXISTS extension_name;

-- Common extensions (uncomment to use):
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";     -- UUID generation
-- CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- Cryptographic functions
-- CREATE EXTENSION IF NOT EXISTS "hstore";        -- Key-value store
-- CREATE EXTENSION IF NOT EXISTS "postgis";       -- Spatial database
-- CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"; -- Query statistics
-- CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- Trigram text search
-- CREATE EXTENSION IF NOT EXISTS "tablefunc";     -- Table functions
-- CREATE EXTENSION IF NOT EXISTS "ltree";         -- Hierarchical tree structures
-- CREATE EXTENSION IF NOT EXISTS "isn";           -- Product number standards
-- CREATE EXTENSION IF NOT EXISTS "citext";        -- Case-insensitive text`)
          .addMarkdown(`#### 3. Verify Installation\nCheck if the extension was successfully installed.`)
          .addMarkdown(`##### ✅ Verification`)
          .addSql(`-- Verify extension installation
SELECT * FROM pg_extension WHERE extname = 'extension_name';`)
          .addMarkdown(`#### 4. List Installed Extensions\nView all currently installed extensions in the database.`)
          .addMarkdown(`##### 📋 Installed Extensions`)
          .addSql(`-- List all installed extensions
SELECT extname as "Name",
       extversion as "Version",
       obj_description(oid, 'pg_extension') as "Description"
FROM pg_extension
ORDER BY extname;`);
      }

      await builder.show();
    }
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create notebook');
  }
}

/**
 * cmdAllDatabaseOperations - Command to create a notebook with various database operations.
 * 
 * @param {DatabaseTreeItem} item - The selected database item from the tree view
 * @param {vscode.ExtensionContext} context - The extension context
 */
export async function cmdDatabaseOperations(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateCategoryItem);
    const { client, metadata } = dbConn;

    // Get database info
    const dbInfo = await client.query(QueryBuilder.databaseStats());
    const info = dbInfo.rows[0];

    // Get schema sizes for visualization
    const schemaSizes = await client.query(QueryBuilder.databaseSchemaSizes());

    // Process schema sizes for visualization
    const schemaMap = new Map<string, number>();
    let totalSize = 0;
    schemaSizes.rows.forEach(row => {
      const size = Number(row.table_size);
      const current = schemaMap.get(row.schema_name) || 0;
      schemaMap.set(row.schema_name, current + size);
      totalSize += size;
    });

    // Generate ASCII Bar Chart in HTML Table
    let schemaDistribution = '<table style="font-size: 11px; width: 100%; border-collapse: collapse;"><tr><th style="text-align: left;">Schema</th><th style="text-align: left;">Size</th><th style="text-align: left;">Distribution</th></tr>';
    schemaMap.forEach((size, schema) => {
      if (size > 0) {
        const percentage = (size / totalSize) * 100;
        const barLength = Math.floor(percentage / 5); // 20 chars max
        const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
        schemaDistribution += `<tr><td><strong>${schema}</strong></td><td>${(size / 1024 / 1024).toFixed(2)} MB</td><td><code>${bar}</code> ${percentage.toFixed(1)}%</td></tr>`;
      }
    });
    schemaDistribution += '</table>';

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📊 Database Operations: \`${item.label}\``) +
        MarkdownUtils.infoBox('Comprehensive database management notebook with statistics, monitoring queries, and administrative operations.') +
        `\n\n#### 📈 Database Overview\n\n` +
        `##### 📊 Schema Size Distribution\n${schemaDistribution}\n\n` +
        `##### 🏥 Health Metrics\n` +
        MarkdownUtils.propertiesTable({
          '🗄️ Database Size': `<code>${info.Size}</code>`,
          '👤 Owner': `<code>${info.Owner}</code>`,
          '🔗 Active Connections': `<code>${info["Active Connections"]}</code>`,
          '📂 Schemas': `<code>${info.Schemas}</code>`,
          '📊 Tables': `<code>${info.Tables}</code>`,
          '👥 Roles': `<code>${info.Roles}</code>`
        }) +
        `\n\n#### 🎯 Available Operations\n\n` +
        `Execute the cells below to:\n` +
        `- 📦 **View schema sizes** - Analyze storage by schema\n` +
        `- 👥 **List users/roles** - Review permissions and access\n` +
        `- 🔍 **Monitor connections** - Track active sessions\n` +
        `- 🧩 **Check extensions** - See installed features\n\n` +
        MarkdownUtils.successBox('Use these queries for monitoring, reporting, and database administration. Modify as needed for your specific use case.') +
        `\n\n---`
      )
      .addMarkdown(`##### 📦 Schema Sizes`)
      .addSql(`-- List schemas and sizes\n` + QueryBuilder.databaseSchemaSizeSummary())
      .addMarkdown(`##### 👥 User Roles & Privileges`)
      .addSql(`-- List users and roles\n` + QueryBuilder.databaseRoles())
      .addMarkdown(`##### 🔗 Active Connections`)
      .addSql(`-- Show active connections\n` + QueryBuilder.databaseActiveConnections())
      .addMarkdown(`##### 🧩 Installed Extensions`)
      .addSql(`-- List installed extensions\n` + QueryBuilder.databaseExtensions())
      .addSql(`-- Database maintenance
-- Note: These operations require appropriate privileges

-- Analyze all tables (updates statistics)
ANALYZE VERBOSE;

-- List tables that might need vacuuming
${QueryBuilder.databaseMaintenanceStats()}

-- To vacuum a specific table (uncomment and modify):
-- VACUUM ANALYZE schema_name.table_name;`)
      .addSql(`-- Terminate connections (BE CAREFUL!)
-- List commands to terminate other connections to this database
${QueryBuilder.databaseTerminateConnections()}`)
      .show();

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create database operations notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdRefreshDatabase - Refreshes the database item in the tree view.
 */
export async function cmdRefreshDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext, databaseTreeProvider?: DatabaseTreeProvider) {
  databaseTreeProvider?.refresh(item);
}

/**
 * cmdCreateDatabase - Command to create a new database.
 */
export async function cmdCreateDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let client;
  try {
    // For creating a database, we connect to postgres database
    const connectionConfig = await getConnectionWithPassword(item.connectionId!);
    client = await ConnectionManager.getInstance().getPooledClient({
      id: connectionConfig.id,
      host: connectionConfig.host,
      port: connectionConfig.port,
      username: connectionConfig.username,
      database: 'postgres',
      name: connectionConfig.name
    });
    const metadata = createMetadata(connectionConfig, 'postgres');

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header('🆕 Create New Database') +
        MarkdownUtils.infoBox('Execute the cell below to create a new database. Modify the database name and options as needed.') +
        `\n\n#### 🎯 Database Options\n\n` +
        MarkdownUtils.operationsTable([
          { operation: 'OWNER', description: 'Specify the database owner' },
          { operation: 'ENCODING', description: 'Character encoding (e.g., UTF8)' },
          { operation: 'TEMPLATE', description: 'Template database to copy from' },
          { operation: 'TABLESPACE', description: 'Default tablespace for the database' },
          { operation: 'CONNECTION LIMIT', description: 'Maximum concurrent connections' }
        ])
      )
      .addMarkdown(`##### 📝 Create Command`)
      .addSql(`-- Create database with basic settings
CREATE DATABASE new_database;

-- Create database with full options
-- CREATE DATABASE new_database
--     WITH OWNER = postgres
--     ENCODING = 'UTF8'
--     LC_COLLATE = 'en_US.UTF-8'
--     LC_CTYPE = 'en_US.UTF-8'
--     TEMPLATE = template0
--     CONNECTION LIMIT = -1;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create database notebook');
  } finally {
    if (client) (client as any).release();
  }
}

/**
 * cmdDeleteDatabase - Command to delete a database.
 */
export async function cmdDeleteDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let client;
  try {
    // For deleting a database, we connect to postgres database
    const connectionConfig = await getConnectionWithPassword(item.connectionId!);
    client = await ConnectionManager.getInstance().getPooledClient({
      id: connectionConfig.id,
      host: connectionConfig.host,
      port: connectionConfig.port,
      username: connectionConfig.username,
      database: 'postgres',
      name: connectionConfig.name
    });
    const metadata = createMetadata(connectionConfig, 'postgres');

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`❌ Delete Database: \`${item.label}\``) +
        MarkdownUtils.dangerBox('This action will <strong>PERMANENTLY DELETE</strong> the database and <strong>ALL DATA</strong>. This cannot be undone!', 'DANGER') +
        `\n\n#### ⚠️ Before You Drop\n\n` +
        `1. **Backup your data** - Create a full backup using pg_dump\n` +
        `2. **Verify connections** - Ensure no active connections to the database\n` +
        `3. **Test on non-production** - Verify the operation is intended\n\n` +
        MarkdownUtils.warningBox('You cannot drop a database while connected to it. This notebook connects to the postgres database to execute the DROP command.')
      )
      .addMarkdown(`##### 🚨 Terminate Active Connections (if needed)`)
      .addSql(`-- Terminate all connections to the database (run this first if needed)
${QueryBuilder.terminateConnectionsByPid(item.label)}`)
      .addMarkdown(`##### ❌ Drop Command`)
      .addSql(`-- Drop database (use with extreme caution!)
DROP DATABASE IF EXISTS "${item.label}";`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create delete database notebook');
  } finally {
    if (client) (client as any).release();
  }
}

export async function cmdBackupDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  try {
    if (!item.connectionId || !item.databaseName) {
      throw new Error('Select a database in the explorer');
    }
    const labelStr = typeof item.label === 'string' ? item.label : String((item.label as { label?: string })?.label ?? item.databaseName);
    await BackupRestorePanel.show(context, {
      initialTab: 'dump',
      connectionId: item.connectionId,
      databaseName: item.databaseName,
      databaseLabel: labelStr
    });
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'open backup workspace');
  }
}

export async function cmdRestoreDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  try {
    if (!item.connectionId || !item.databaseName) {
      throw new Error('Select a database in the explorer');
    }
    const labelStr = typeof item.label === 'string' ? item.label : String((item.label as { label?: string })?.label ?? item.databaseName);
    await BackupRestorePanel.show(context, {
      initialTab: 'restore',
      connectionId: item.connectionId,
      databaseName: item.databaseName,
      databaseLabel: labelStr
    });
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'open restore workspace');
  }
}

/** Command Palette: pick connection → database, then open Backup & Restore panel. */
export async function cmdOpenBackupWorkspaceFromPalette(context: vscode.ExtensionContext): Promise<void> {
  const connections =
    vscode.workspace.getConfiguration().get<Array<Record<string, unknown>>>('postgresExplorer.connections') || [];
  if (connections.length === 0) {
    await vscode.window.showErrorMessage('No saved connections. Add one in settings.');
    return;
  }

  const connPick = await vscode.window.showQuickPick(
    connections.map((c: any) => ({
      label: (c.name as string) || `${c.host}:${c.port}`,
      description: (c.database as string) || 'postgres',
      conn: c
    })),
    { title: 'Backup & Restore: Connection', placeHolder: 'Select a saved connection' }
  );
  if (!connPick?.conn) {
    return;
  }

  const connection = connPick.conn as Record<string, unknown> & {
    id: string;
    host: string;
    port: number;
    database?: string;
  };
  const bootstrapDb = connection.database || 'postgres';

  let tempClient;
  try {
    tempClient = await ConnectionManager.getInstance().getPooledClient({
      ...(connection as any),
      database: bootstrapDb
    });
  } catch (err: any) {
    await vscode.window.showErrorMessage(`Could not connect: ${err?.message || String(err)}`);
    return;
  }

  try {
    const dbsResult = await tempClient.query(`
      SELECT datname FROM pg_database
      WHERE datallowconn = true AND datistemplate = false
      ORDER BY datname
    `);
    const databases = dbsResult.rows.map((r: { datname: string }) => r.datname);
    const dbChoice = await vscode.window.showQuickPick(databases, {
      title: 'Backup & Restore: Database',
      placeHolder: 'Database to associate with the workspace'
    });
    if (!dbChoice) {
      return;
    }

    await BackupRestorePanel.show(context, {
      initialTab: 'dump',
      connectionId: connection.id,
      databaseName: dbChoice,
      databaseLabel: dbChoice
    });
  } finally {
    tempClient.release();
  }
}

export async function cmdGenerateCreateScript(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let client;
  try {
    const connectionConfig = await getConnectionWithPassword(item.connectionId!);
    client = await ConnectionManager.getInstance().getPooledClient({
      id: connectionConfig.id,
      host: connectionConfig.host,
      port: connectionConfig.port,
      username: connectionConfig.username,
      database: 'postgres', // Connect to postgres to get DB definition
      name: connectionConfig.name
    });
    const metadata = createMetadata(connectionConfig, 'postgres');

    const res = await client.query(`
            SELECT 'CREATE DATABASE "' || datname || '" WITH OWNER = "' || pg_get_userbyid(datdba) || '"' ||
            ' ENCODING = ''' || pg_encoding_to_char(encoding) || '''' ||
            ' LC_COLLATE = ''' || datcollate || '''' ||
            ' LC_CTYPE = ''' || datctype || ''';' as create_sql
            FROM pg_database WHERE datname = $1
        `, [item.databaseName]);

    const createSql = res.rows[0]?.create_sql || `-- Failed to generate CREATE script for ${item.databaseName}`;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📝 CREATE Script: \`${item.label}\``) +
        MarkdownUtils.infoBox('This is the SQL script to recreate the database definition. Copy and modify as needed.') +
        `\n\n#### 📚 Database Properties\n\n` +
        `The script includes:\n` +
        `- 👤 Owner specification\n` +
        `- 📝 Character encoding\n` +
        `- 🌐 Locale settings (collation and ctype)\n`
      )
      .addMarkdown(`##### 📄 Database Definition`)
      .addSql(createSql)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate create script');
  } finally {
    if (client) (client as any).release();
  }
}

export async function cmdDisconnectDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  try {
    vscode.window.showInformationMessage(`Disconnected from ${item.label} (Session cleared)`);
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'disconnect');
  }
}

export async function cmdMaintenanceDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateCategoryItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🛠️ Database Maintenance: \`${item.label}\``) +
        MarkdownUtils.infoBox('Perform standard maintenance operations to optimize database performance.') +
        `\n\n#### 🎯 Maintenance Operations\n\n` +
        MarkdownUtils.operationsTable([
          { operation: 'VACUUM', description: 'Reclaims storage occupied by dead tuples' },
          { operation: 'ANALYZE', description: 'Updates optimizer statistics for better query plans' },
          { operation: 'REINDEX', description: 'Rebuilds indexes (use during maintenance windows)' },
          { operation: 'VACUUM FULL', description: 'Compacts tables (requires exclusive lock)' }
        ]) +
        `\n\n#### ⏱️ When to Run\n\n` +
        `- ✅ After large batch DELETE or UPDATE operations\n` +
        `- ✅ When query performance degrades\n` +
        `- ✅ Before major reporting operations\n` +
        `- ✅ During scheduled maintenance windows\n\n` +
        MarkdownUtils.successBox('PostgreSQL has autovacuum running automatically, but manual maintenance can be useful after bulk operations.')
      )
      .addMarkdown(`##### 🧹 VACUUM & ANALYZE`)
      .addSql(MaintenanceTemplates.vacuumAnalyzeDatabase())
      .addMarkdown(`##### 📊 Tables Needing Maintenance`)
      .addSql(`-- Check tables with dead tuples\n` + QueryBuilder.databaseMaintenanceStats())
      .addMarkdown(`##### 🔄 REINDEX (Use with Caution)`)
      .addSql(MaintenanceTemplates.reindexDatabase(item.label) + `\n\n-- Reindex specific table (safer approach)\n-- REINDEX TABLE schema_name.table_name;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'create maintenance notebook');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function cmdQueryTool(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateCategoryItem);
    const { metadata } = dbConn;

    await openOrCreateNotebookWithPicker(
      metadata,
      [
        {
          kind: 'markdown',
          value:
            MarkdownUtils.header(`📝 Query Tool: \`${item.label}\``) +
            MarkdownUtils.infoBox('Write and execute SQL queries against this database.'),
        },
        {
          kind: 'sql',
          value: `-- Write your SQL query here
SELECT 1;`,
        },
      ],
      context,
      `Open or Create Notebook (${item.label})`
    );
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'open query tool');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

export async function cmdPsqlTool(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  try {
    const connectionConfig = await getConnectionWithPassword(item.connectionId!, item.databaseName);

    const terminal = vscode.window.createTerminal(`PSQL: ${item.label}`);
    terminal.show();
    terminal.sendText(`psql -h ${connectionConfig.host} -p ${connectionConfig.port} -U ${connectionConfig.username} -d "${item.label}"`);

  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'open PSQL tool');
  }
}

export async function cmdShowConfiguration(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  let dbConn;
  try {
    dbConn = await getDatabaseConnection(item, validateCategoryItem);
    const { metadata } = dbConn;

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`⚙️ Database Configuration: \`${item.label}\``) +
        MarkdownUtils.infoBox('View and analyze current configuration settings for this PostgreSQL database.') +
        `\n\n#### 📚 Configuration Categories\n\n` +
        MarkdownUtils.operationsTable([
          { operation: 'Connections', description: 'Connection limits, timeouts, and authentication' },
          { operation: 'Memory', description: 'Shared buffers, work memory, maintenance memory' },
          { operation: 'WAL', description: 'Write-ahead logging and checkpoint settings' },
          { operation: 'Query Tuning', description: 'Planner costs, parallelism, and optimization' },
          { operation: 'Logging', description: 'Log destinations, levels, and rotation' }
        ]) +
        `\n\n` +
        MarkdownUtils.successBox('Filter by category to find specific settings. Most settings require a server restart to change.')
      )
      .addMarkdown(`##### 📋 All Configuration Settings`)
      .addSql(`-- View all configuration settings\n` + QueryBuilder.databaseConfiguration())
      .addMarkdown(`##### 💻 Memory Settings`)
      .addSql(`-- Memory-related settings\n` + QueryBuilder.databaseMemorySettings())
      .addMarkdown(`##### 🔗 Connection Settings`)
      .addSql(`-- Connection-related settings\n` + QueryBuilder.databaseConnectionSettings())
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'show configuration');
  } finally {
    if (dbConn && dbConn.release) dbConn.release();
  }
}

/**
 * cmdScriptAlterDatabase - Command to generate ALTER DATABASE script.
 */
export async function cmdScriptAlterDatabase(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  try {
    const connectionConfig = await getConnectionWithPassword(item.connectionId!);
    const metadata = createMetadata(connectionConfig, item.databaseName);

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📝 ALTER Database: \`${item.label}\``) +
        MarkdownUtils.infoBox('Use these commands to modify database attributes. Uncomment and modify the operations you want to perform.') +
        `\n\n#### 🎯 Available Modifications\n\n` +
        MarkdownUtils.operationsTable([
          { operation: 'RENAME', description: 'Change the database name' },
          { operation: 'OWNER', description: 'Transfer ownership to another role' },
          { operation: 'SET', description: 'Set runtime configuration parameters' },
          { operation: 'CONNECTION LIMIT', description: 'Set maximum concurrent connections' },
          { operation: 'TABLESPACE', description: 'Change default tablespace' }
        ]) +
        `\n\n` +
        MarkdownUtils.warningBox('Some operations require exclusive access to the database. Rename operations require no active connections.')
      )
      .addMarkdown(`##### 🔄 Rename Database`)
      .addSql(`-- Rename database (requires no active connections)
-- ALTER DATABASE "${item.label}" RENAME TO new_name;`)
      .addMarkdown(`##### 👤 Change Owner`)
      .addSql(`-- Change database owner
-- ALTER DATABASE "${item.label}" OWNER TO new_owner;`)
      .addMarkdown(`##### ⚙️ Set Configuration Parameters`)
      .addSql(`-- Set configuration parameter for this database
-- ALTER DATABASE "${item.label}" SET configuration_parameter TO value;

-- Example: Set search path
-- ALTER DATABASE "${item.label}" SET search_path TO schema_name, public;

-- Example: Set timezone
-- ALTER DATABASE "${item.label}" SET timezone TO 'UTC';

-- Reset to default
-- ALTER DATABASE "${item.label}" RESET configuration_parameter;`)
      .addMarkdown(`##### 🔌 Connection Limit`)
      .addSql(`-- Set connection limit (-1 for unlimited)
-- ALTER DATABASE "${item.label}" WITH CONNECTION LIMIT 50;`)
      .addMarkdown(`##### 📁 Change Tablespace`)
      .addSql(`-- Move database to different tablespace
-- ALTER DATABASE "${item.label}" SET TABLESPACE new_tablespace;`)
      .show();
  } catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate alter script');
  }
}