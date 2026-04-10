/**
 * SQL Templates for Type Operations
 */

export const TypeSQL = {
    /**
     * Create a composite type
     */
    createComposite: (schema: string) =>
        `-- Create composite type
CREATE TYPE "${schema}".type_name AS (
    field1 text,
    field2 integer
);`,

    /**
     * Create an enum type
     */
    createEnum: (schema: string) =>
        `-- Create enum type
CREATE TYPE "${schema}".status_enum AS ENUM (
    'active',
    'inactive',
    'pending'
);`,

    /**
     * Drop type
     */
    drop: (schema: string, typeName: string) =>
        `-- Drop type
DROP TYPE "${schema}"."${typeName}";

-- Use CASCADE to also drop dependent objects
-- DROP TYPE "${schema}"."${typeName}" CASCADE;`,

    /**
     * Rename type
     */
    rename: (schema: string, typeName: string) =>
        `-- Rename type
ALTER TYPE "${schema}"."${typeName}" RENAME TO new_type_name;`,

    /**
     * Find type usage
     */
    findUsage: (schema: string, typeName: string) =>
        `-- Find columns using this type
SELECT 
    n.nspname as schema_name,
    c.relname as table_name,
    a.attname as column_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE t.typname = '${typeName}' AND n.nspname = '${schema}';`,
};
