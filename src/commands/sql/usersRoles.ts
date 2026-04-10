/**
 * SQL Templates for User and Role Operations
 */

export const UserRoleSQL = {
    /**
     * CREATE USER template
     */
    createUser: (databaseName: string) =>
        `-- Create a new user with login privileges
CREATE USER new_username WITH
    LOGIN
    PASSWORD 'strong_password_here'
    -- CREATEDB
    -- CREATEROLE
    -- SUPERUSER
    -- REPLICATION
    -- CONNECTION LIMIT 10
    -- VALID UNTIL '2025-12-31'
;

-- Grant connect privilege to specific database
GRANT CONNECT ON DATABASE ${databaseName} TO new_username;

-- Use role membership to assign permissions
-- GRANT existing_role TO new_username;`,

    /**
     * CREATE ROLE template
     */
    createRole: () =>
        `-- Create a new role (without login)
CREATE ROLE new_role_name WITH
    NOLOGIN
    INHERIT
    -- CREATEDB
    -- CREATEROLE
    -- SUPERUSER
;

-- Grant role to users
-- GRANT new_role_name TO some_user;`,

    /**
     * ALTER ROLE template
     */
    alterRole: (roleName: string) =>
        `-- Modify role attributes
ALTER ROLE ${roleName}
    -- WITH PASSWORD 'new_password'
    -- SUPERUSER | NOSUPERUSER
    -- CREATEDB | NOCREATEDB
    -- CREATEROLE | NOCREATEROLE
    -- LOGIN | NOLOGIN
    -- INHERIT | NOINHERIT
    -- REPLICATION | NOREPLICATION
    -- CONNECTION LIMIT 5
    -- VALID UNTIL '2025-12-31'
;

-- Use RENAME TO to rename the role
-- ALTER ROLE ${roleName} RENAME TO new_role_name;

-- Use SET to apply role-specific configuration
-- ALTER ROLE ${roleName} SET search_path TO public, my_schema;`,

    /**
     * GRANT privileges template — covers schema, tables, functions, and sequences
     */
    grant: (roleName: string) =>
        `-- Grant schema usage
GRANT USAGE ON SCHEMA public TO ${roleName};

-- Grant table privileges
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roleName};
-- GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName};

-- Grant function and sequence privileges
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${roleName};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${roleName};

-- Set default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${roleName};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${roleName};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${roleName};

-- Use WITH ADMIN OPTION to allow the role to grant to others
-- GRANT ${roleName} TO some_user WITH ADMIN OPTION;`,

    /**
     * DROP ROLE template
     */
    dropRole: (roleName: string) =>
        `-- Drop the role
DROP ROLE ${roleName};

-- Use IF EXISTS to suppress error if role does not exist
-- DROP ROLE IF EXISTS ${roleName};`,
};

// Backward-compatibility alias
export { UserRoleSQL as UsersRolesSQL };
