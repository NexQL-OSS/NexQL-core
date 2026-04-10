/**
 * SQL Templates for Constraint Operations
 */

export const ConstraintSQL = {
    /**
     * Add primary key constraint
     */
    addPrimaryKey: (schema: string, tableName: string) =>
        `-- Add primary key constraint
ALTER TABLE "${schema}"."${tableName}"
ADD CONSTRAINT ${tableName}_pkey PRIMARY KEY (id);

-- Use composite primary key when multiple columns form the key
-- ALTER TABLE "${schema}"."${tableName}"
-- ADD CONSTRAINT ${tableName}_pkey PRIMARY KEY (column1, column2);`,

    /**
     * Add foreign key constraint
     */
    addForeignKey: (schema: string, tableName: string) =>
        `-- Add foreign key constraint
ALTER TABLE "${schema}"."${tableName}"
ADD CONSTRAINT fk_${tableName}_reference
    FOREIGN KEY (reference_id)
    REFERENCES ${schema}.other_table(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- Use ON DELETE SET NULL when child rows should be kept with null reference
-- ALTER TABLE "${schema}"."${tableName}"
-- ADD CONSTRAINT fk_${tableName}_reference
--     FOREIGN KEY (reference_id)
--     REFERENCES ${schema}.other_table(id)
--     ON DELETE SET NULL;

-- Use ON DELETE RESTRICT when deletion of parent should be prevented
-- ALTER TABLE "${schema}"."${tableName}"
-- ADD CONSTRAINT fk_${tableName}_reference
--     FOREIGN KEY (reference_id)
--     REFERENCES ${schema}.other_table(id)
--     ON DELETE RESTRICT;`,

    /**
     * Add unique constraint
     */
    addUnique: (schema: string, tableName: string) =>
        `-- Add unique constraint on single column
ALTER TABLE "${schema}"."${tableName}"
ADD CONSTRAINT ${tableName}_email_unique UNIQUE (email);

-- Use composite unique when uniqueness spans multiple columns
-- ALTER TABLE "${schema}"."${tableName}"
-- ADD CONSTRAINT ${tableName}_multi_unique UNIQUE (column1, column2);`,

    /**
     * Add check constraint
     */
    addCheck: (schema: string, tableName: string) =>
        `-- Add CHECK constraint for value validation
ALTER TABLE "${schema}"."${tableName}"
ADD CONSTRAINT ${tableName}_status_check
    CHECK (status IN ('active', 'inactive', 'pending'));

-- Use range check when column must fall within numeric bounds
-- ALTER TABLE "${schema}"."${tableName}"
-- ADD CONSTRAINT ${tableName}_age_check CHECK (age >= 0 AND age <= 150);

-- Use compare columns when one column must relate to another
-- ALTER TABLE "${schema}"."${tableName}"
-- ADD CONSTRAINT ${tableName}_date_check CHECK (end_date > start_date);`,

    /**
     * Drop constraint
     */
    drop: (schema: string, tableName: string, constraintName: string) =>
        `-- Drop constraint
ALTER TABLE "${schema}"."${tableName}"
DROP CONSTRAINT "${constraintName}";

-- Use CASCADE to also drop dependent objects
-- ALTER TABLE "${schema}"."${tableName}"
-- DROP CONSTRAINT "${constraintName}" CASCADE;`,

    /**
     * Validate constraint
     */
    validate: (schema: string, tableName: string, constraintName: string) =>
        `-- Validate constraint ${constraintName}
ALTER TABLE "${schema}"."${tableName}"
VALIDATE CONSTRAINT "${constraintName}";`,
};
