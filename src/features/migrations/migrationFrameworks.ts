// ---------------------------------------------------------------------------
// Pure, dependency-free migration-framework catalog + detector.
// `detectFrameworks` takes an injected `exists` predicate so it can be unit
// tested without touching the filesystem.
// ---------------------------------------------------------------------------

export interface MigrationCommands {
  status?: string;
  apply: string;
  rollback?: string;
  create?: string;
}

export interface MigrationFramework {
  id: string;
  name: string;
  /** Relative paths/globs-as-prefixes; any one present marks the framework as detected. */
  signatures: string[];
  /** Docs URL for the framework's migration workflow. */
  docs: string;
  commands: MigrationCommands;
}

export const MIGRATION_FRAMEWORKS: MigrationFramework[] = [
  {
    id: 'prisma',
    name: 'Prisma',
    signatures: ['prisma/schema.prisma', 'prisma/migrations'],
    docs: 'https://www.prisma.io/docs/orm/prisma-migrate',
    commands: {
      status: 'npx prisma migrate status',
      apply: 'npx prisma migrate deploy',
      rollback: '# Prisma has no down migrations; create a new corrective migration',
      create: 'npx prisma migrate dev --name <name>',
    },
  },
  {
    id: 'drizzle',
    name: 'Drizzle ORM',
    signatures: ['drizzle.config.ts', 'drizzle.config.js', 'drizzle'],
    docs: 'https://orm.drizzle.team/docs/migrations',
    commands: {
      apply: 'npx drizzle-kit migrate',
      create: 'npx drizzle-kit generate',
    },
  },
  {
    id: 'alembic',
    name: 'Alembic (SQLAlchemy)',
    signatures: ['alembic.ini', 'alembic'],
    docs: 'https://alembic.sqlalchemy.org/en/latest/tutorial.html',
    commands: {
      status: 'alembic current',
      apply: 'alembic upgrade head',
      rollback: 'alembic downgrade -1',
      create: 'alembic revision --autogenerate -m "<message>"',
    },
  },
  {
    id: 'flyway',
    name: 'Flyway',
    signatures: ['flyway.conf', 'flyway.toml'],
    docs: 'https://documentation.red-gate.com/flyway',
    commands: {
      status: 'flyway info',
      apply: 'flyway migrate',
      rollback: 'flyway undo  # requires Flyway Teams',
    },
  },
  {
    id: 'atlas',
    name: 'Atlas',
    signatures: ['atlas.hcl'],
    docs: 'https://atlasgo.io/versioned/intro',
    commands: {
      status: 'atlas migrate status --env local',
      apply: 'atlas migrate apply --env local',
      create: 'atlas migrate diff <name> --env local',
    },
  },
  {
    id: 'knex',
    name: 'Knex.js',
    signatures: ['knexfile.js', 'knexfile.ts'],
    docs: 'https://knexjs.org/guide/migrations.html',
    commands: {
      status: 'npx knex migrate:status',
      apply: 'npx knex migrate:latest',
      rollback: 'npx knex migrate:rollback',
      create: 'npx knex migrate:make <name>',
    },
  },
  {
    id: 'rails',
    name: 'Rails (ActiveRecord)',
    signatures: ['db/migrate', 'config/database.yml'],
    docs: 'https://guides.rubyonrails.org/active_record_migrations.html',
    commands: {
      status: 'bin/rails db:migrate:status',
      apply: 'bin/rails db:migrate',
      rollback: 'bin/rails db:rollback',
      create: 'bin/rails generate migration <name>',
    },
  },
  {
    id: 'golang-migrate',
    name: 'golang-migrate',
    signatures: ['db/migration', 'migrate.json'],
    docs: 'https://github.com/golang-migrate/migrate',
    commands: {
      apply: 'migrate -path ./migrations -database "$DATABASE_URL" up',
      rollback: 'migrate -path ./migrations -database "$DATABASE_URL" down 1',
      create: 'migrate create -ext sql -dir ./migrations <name>',
    },
  },
];

/**
 * Detect which migration frameworks a workspace uses.
 * @param exists predicate that returns true when a workspace-relative path exists.
 */
export function detectFrameworks(exists: (relPath: string) => boolean): MigrationFramework[] {
  return MIGRATION_FRAMEWORKS.filter((fw) => fw.signatures.some((sig) => exists(sig)));
}
