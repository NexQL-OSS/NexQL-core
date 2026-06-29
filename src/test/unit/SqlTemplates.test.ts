import { expect } from 'chai';

import {
  AggregateSQL,
  ColumnSQL,
  ConstraintSQL,
  DomainSQL,
  ExtensionSQL,
  ForeignDataWrapperSQL,
  ForeignTableSQL,
  FunctionSQL,
  IndexSQL,
  MaintenanceTemplates,
  MaterializedViewSQL,
  PgCronSQL,
  PolicySQL,
  QueryBuilder,
  PartitionSQL,
  SQL_TEMPLATES,
  SchemaSQL,
  SequenceSQL,
  TableSQL,
  EventTriggerSQL,
  TriggerSQL,
  TypeSQL,
  UserRoleSQL,
  UsersRolesSQL,
  ViewSQL,
} from '../../commands/sql';
import * as ProfileSQL from '../../commands/sql/profile';

function expectSqlContains(sql: string, fragments: string[]): void {
  for (const fragment of fragments) {
    expect(sql).to.contain(fragment);
  }
}

describe('SQL template modules', () => {
  const schema = 'public';
  const table = 'users';
  const column = 'email';
  const indexName = 'users_email_idx';

  it('covers the shared helper templates', () => {
    expect(SQL_TEMPLATES.DROP.TABLE(schema, table)).to.equal('-- Drop table\nDROP TABLE IF EXISTS "public"."users";');
    expect(SQL_TEMPLATES.DROP.VIEW(schema, table)).to.equal('-- Drop view\nDROP VIEW IF EXISTS public.users;');
    expect(SQL_TEMPLATES.DROP.MATERIALIZED_VIEW(schema, table)).to.equal('-- Drop materialized view\nDROP MATERIALIZED VIEW IF EXISTS public.users;');
    expect(SQL_TEMPLATES.DROP.FUNCTION(schema, table, 'integer')).to.contain('DROP FUNCTION IF EXISTS public.users(integer);');
    expect(SQL_TEMPLATES.DROP.INDEX(schema, indexName)).to.contain('DROP INDEX "public"."users_email_idx";');
    expect(SQL_TEMPLATES.DROP.CONSTRAINT(schema, table, 'users_email_key')).to.contain('DROP CONSTRAINT "users_email_key";');
    expect(SQL_TEMPLATES.DROP.TYPE(schema, 'customer_status')).to.contain('DROP TYPE IF EXISTS public.customer_status CASCADE;');
    expect(SQL_TEMPLATES.DROP.EXTENSION('uuid-ossp')).to.contain('DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;');

    expect(SQL_TEMPLATES.SELECT.ALL(schema, table)).to.contain('LIMIT 100;');
    expect(SQL_TEMPLATES.SELECT.ALL(schema, table, 25)).to.contain('LIMIT 25;');
    expect(SQL_TEMPLATES.SELECT.WITH_WHERE(schema, table)).to.contain('WHERE condition');

    expect(SQL_TEMPLATES.COMMENT.TABLE(schema, table, "It's ours")).to.contain("IS 'It''s ours';");
    expect(SQL_TEMPLATES.COMMENT.COLUMN(schema, table, column, 'Column comment')).to.contain('COMMENT ON COLUMN public.users.email');
    expect(SQL_TEMPLATES.COMMENT.VIEW(schema, 'orders_view', 'View comment')).to.contain('COMMENT ON VIEW public.orders_view');
    expect(SQL_TEMPLATES.COMMENT.FUNCTION(schema, 'calc_total', 'integer', 'Function comment')).to.contain('COMMENT ON FUNCTION public.calc_total(integer)');
    expect(SQL_TEMPLATES.COMMENT.TYPE(schema, 'status_enum', 'Type comment')).to.contain('COMMENT ON TYPE public.status_enum');

    expect(QueryBuilder.objectInfo('table', schema, table)).to.contain('information_schema.tables');
    expect(QueryBuilder.objectInfo('view', schema, table)).to.contain('information_schema.views');
    expect(QueryBuilder.objectInfo('function', schema, table)).to.contain('information_schema.routines');
    expect(QueryBuilder.objectInfo('type', schema, table)).to.contain('information_schema.user_defined_types');
    expect(QueryBuilder.objectInfo('unknown' as any, schema, table)).to.equal(undefined);
    expect(QueryBuilder.privileges(schema, table)).to.contain('information_schema.table_privileges');
    expect(QueryBuilder.dependencies(schema, table)).to.contain('pg_depend');
    expect(QueryBuilder.columns(schema, table)).to.contain('information_schema.columns');
    expect(QueryBuilder.tableColumns(schema, table)).to.contain('col_description');
    expect(QueryBuilder.constraintDetails(schema, table, 'users_email_key')).to.contain('information_schema.table_constraints');
    expect(QueryBuilder.foreignKeyDetails(schema, 'users_fk')).to.contain('information_schema.referential_constraints');
    expect(QueryBuilder.columnDetails(schema, table, column)).to.contain('is_primary_key');
    expect(QueryBuilder.tableIndexes(schema, table)).to.contain('pg_index');
    expect(QueryBuilder.tableConstraints(schema, table)).to.contain('referenced_table');
    expect(QueryBuilder.tableConstraintDefinitions(schema, table)).to.contain('pg_get_constraintdef');
    expect(QueryBuilder.tableStats(schema, table)).to.contain('pg_stat_user_tables');
    expect(QueryBuilder.tableSize(schema, table)).to.contain('pg_total_relation_size');
    expect(QueryBuilder.tableInfo(schema, table)).to.contain('pg_class c');
    expect(QueryBuilder.viewDefinition(schema, 'orders_view')).to.contain('pg_get_viewdef');
    expect(QueryBuilder.viewInfo(schema, 'orders_view')).to.contain('c.relkind = \'v\'');
    expect(QueryBuilder.viewSize(schema, 'orders_view')).to.contain('view_size');
    expect(QueryBuilder.typeInfo(schema, 'status_enum')).to.contain('type_type');
    expect(QueryBuilder.typeFields(schema, 'status_enum')).to.contain('format_type');
    expect(QueryBuilder.roleDetails('app_user')).to.contain('WITH RECURSIVE');
    expect(QueryBuilder.roleAttributes('app_user')).to.contain('pg_authid');
    expect(QueryBuilder.functionInfo(schema, 'calc_total')).to.contain('pg_get_function_arguments');
    expect(QueryBuilder.functionDefinition(schema, 'calc_total')).to.contain('pg_get_functiondef');
    expect(QueryBuilder.functionSignature(schema, 'calc_total')).to.contain('pg_get_function_result');
    expect(QueryBuilder.functionArguments(schema, 'calc_total')).to.contain('pg_get_function_arguments');
    expect(QueryBuilder.schemaInfo(schema)).to.contain('tables_count');
    expect(QueryBuilder.schemaDetails(schema)).to.contain('pg_namespace');
    expect(QueryBuilder.schemaObjectCounts(schema)).to.contain('trigger_count');
    expect(QueryBuilder.schemaSize(schema)).to.contain('relation_count');
    expect(QueryBuilder.schemaPrivileges(schema)).to.contain('routine_privileges');
    expect(QueryBuilder.schemaExtensions(schema)).to.contain('pg_extension');
    expect(QueryBuilder.schemaDependencies(schema)).to.contain('LIMIT 10');
    expect(QueryBuilder.schemaAllObjects(schema)).to.contain('estimated_row_count');
    expect(QueryBuilder.extensionObjects('uuid-ossp')).to.contain('pg_catalog.pg_depend');
    expect(QueryBuilder.foreignTableInfo(schema, 'remote_users')).to.contain('pg_foreign_table');
    expect(QueryBuilder.foreignTableDefinition(schema, 'remote_users')).to.contain('array_agg');
    expect(QueryBuilder.matViewInfo(schema, 'sales_mv')).to.contain('pg_matviews');
    expect(QueryBuilder.matViewDefinition(schema, 'sales_mv')).to.contain('pg_get_viewdef');
    expect(QueryBuilder.matViewStats(schema, 'sales_mv')).to.contain('pg_stat_user_tables');
    expect(QueryBuilder.objectDependencies(schema, 'sales_mv')).to.contain('pg_depend');
    expect(QueryBuilder.objectReferences(schema, 'sales_mv')).to.contain('pg_rewrite');
    expect(QueryBuilder.databaseStats()).to.contain('pg_database d');
    expect(QueryBuilder.databaseSchemaSizes()).to.contain('pg_total_relation_size');
    expect(QueryBuilder.databaseSchemaSizeSummary()).to.contain('GROUP BY schema_name');
    expect(QueryBuilder.databaseMaintenanceStats()).to.contain('Dead Tuples');
    expect(QueryBuilder.databaseConfiguration()).to.contain('pg_settings');
    expect(QueryBuilder.databaseMemorySettings()).to.contain('Memory');
    expect(QueryBuilder.databaseConnectionSettings()).to.contain('Connection');
    expect(QueryBuilder.databaseActiveConnections()).to.contain('pg_stat_activity');
    expect(QueryBuilder.databaseExtensions()).to.contain('pg_available_extensions');
    expect(QueryBuilder.databaseRoles()).to.contain('pg_roles r');
    expect(QueryBuilder.databaseTerminateConnections()).to.contain('WHERE datname = current_database()');
    expect(QueryBuilder.databaseTerminateConnections('inventory')).to.contain("WHERE datname = 'inventory'");
    expect(QueryBuilder.terminateConnectionsByPid('inventory')).to.contain('pg_terminate_backend(pid)');

    expect(MaintenanceTemplates.vacuum(schema, table)).to.contain('VACUUM (VERBOSE, ANALYZE) public.users;');
    expect(MaintenanceTemplates.analyze(schema, table)).to.contain('ANALYZE VERBOSE public.users;');
    expect(MaintenanceTemplates.reindex(schema, table)).to.contain('REINDEX TABLE public.users;');
    expect(MaintenanceTemplates.vacuumFull(schema, table)).to.contain('VACUUM FULL public.users;');
    expect(MaintenanceTemplates.vacuumAnalyzeDatabase()).to.contain('VACUUM (VERBOSE, ANALYZE);');
    expect(MaintenanceTemplates.reindexDatabase('app_db')).to.contain('REINDEX DATABASE "app_db";');
  });

  it('covers pg_cron SQL templates', () => {
    expectSqlContains(PgCronSQL.listJobs(), ['FROM cron.job', 'jobid']);
    expectSqlContains(PgCronSQL.installExtension(), ['CREATE EXTENSION IF NOT EXISTS pg_cron']);
    expectSqlContains(PgCronSQL.jobDetail(3), ['FROM cron.job', 'WHERE jobid = 3']);
    expectSqlContains(PgCronSQL.unschedule(9), ['cron.unschedule', '9']);
    expectSqlContains(PgCronSQL.scheduleNewJob(), ['cron.schedule']);
    expectSqlContains(PgCronSQL.scheduleBackupShellExample(), ['nexql-pgdump', 'cron.schedule']);
  });

  it('covers RLS policy SQL templates', () => {
    expectSqlContains(PolicySQL.drop('public', 'accounts', 'tenant_isolation'), [
      'DROP POLICY IF EXISTS',
      '"tenant_isolation"',
      'ON "public"."accounts"',
    ]);
  });

  it('covers aggregate, domain, partition, sequence and trigger SQL builders', () => {
    expectSqlContains(AggregateSQL.list(schema), ['FROM pg_proc p', "p.prokind = 'a'"]);
    expectSqlContains(AggregateSQL.getDefinition(schema, 'sum_salary'), ['JOIN pg_aggregate a', 'transition_function']);
    expect(AggregateSQL.drop(schema, 'sum_salary', 'integer')).to.equal('DROP AGGREGATE IF EXISTS "public"."sum_salary"(integer);');
    expectSqlContains(AggregateSQL.create(schema), ['CREATE AGGREGATE "public"."new_aggregate_name"', 'SFUNC = transition_function']);

    expectSqlContains(DomainSQL.list(schema), ['FROM pg_type t', "t.typtype = 'd'"]);
    expectSqlContains(DomainSQL.getDefinition(schema, 'status_domain'), ['pg_get_constraintdef', 'constraint_name']);
    expectSqlContains(DomainSQL.create(schema), ['CREATE DOMAIN "public"."new_domain_name" AS text', 'CHECK (VALUE ~']);
    expect(DomainSQL.drop(schema, 'status_domain')).to.equal('DROP DOMAIN IF EXISTS "public"."status_domain";');
    expect(DomainSQL.dropCascade(schema, 'status_domain')).to.equal('DROP DOMAIN IF EXISTS "public"."status_domain" CASCADE;');

    expectSqlContains(PartitionSQL.list(schema, table), ['FROM pg_inherits i', 'relpartbound']);
    expectSqlContains(PartitionSQL.isPartitioned(schema, table), ["c.relkind = 'p'", 'pg_get_partkeydef']);
    expect(PartitionSQL.attach(schema, table, 'public', 'users_2026_01', "FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')")).to.contain('ATTACH PARTITION "public"."users_2026_01"');
    expect(PartitionSQL.detach(schema, table, 'users_2026_01')).to.equal('ALTER TABLE "public"."users" DETACH PARTITION "users_2026_01";');
    expectSqlContains(PartitionSQL.createRangePartition(schema, table), ['CREATE TABLE "public"."partition_name" PARTITION OF "public"."users"', 'FOR VALUES FROM']);
    expectSqlContains(PartitionSQL.createListPartition(schema, table), ['CREATE TABLE "public"."partition_name" PARTITION OF "public"."users"', 'FOR VALUES IN']);

    expectSqlContains(SequenceSQL.list(schema), ['FROM pg_sequences', 'ORDER BY sequencename']);
    expectSqlContains(SequenceSQL.getDefinition(schema, 'order_seq'), ['FROM pg_sequences s', 'sequence_owner']);
    expect(SequenceSQL.nextValue(schema, 'order_seq')).to.equal("SELECT nextval('\"public\".\"order_seq\"') AS next_value;");
    expect(SequenceSQL.currentValue(schema, 'order_seq')).to.equal('SELECT last_value, is_called FROM "public"."order_seq";');
    expect(SequenceSQL.resetValue(schema, 'order_seq', 42)).to.equal("SELECT setval('\"public\".\"order_seq\"', 42);");
    expectSqlContains(SequenceSQL.create(schema), ['CREATE SEQUENCE "public"."new_sequence_name"', 'NO CYCLE']);
    expect(SequenceSQL.drop(schema, 'order_seq')).to.equal('DROP SEQUENCE IF EXISTS "public"."order_seq";');
    expectSqlContains(SequenceSQL.alter(schema, 'order_seq'), ['ALTER SEQUENCE "public"."order_seq"', 'RESTART WITH 1']);

    expectSqlContains(TriggerSQL.list(schema, table), ['FROM information_schema.triggers t', 'trigger_status']);
    expectSqlContains(TriggerSQL.getDefinition(schema, table, 'users_audit_trigger'), ['pg_get_triggerdef', 'status']);
    expect(TriggerSQL.drop(schema, table, 'users_audit_trigger')).to.equal('DROP TRIGGER IF EXISTS "users_audit_trigger" ON "public"."users";');
    expect(TriggerSQL.enable(schema, table, 'users_audit_trigger')).to.equal('ALTER TABLE "public"."users" ENABLE TRIGGER "users_audit_trigger";');
    expect(TriggerSQL.disable(schema, table, 'users_audit_trigger')).to.equal('ALTER TABLE "public"."users" DISABLE TRIGGER "users_audit_trigger";');
    expectSqlContains(TriggerSQL.create(schema, table), ['CREATE OR REPLACE FUNCTION public.trigger_function_name()', 'CREATE TRIGGER trigger_name']);

    expectSqlContains(EventTriggerSQL.list(), ['FROM pg_event_trigger', 'REPLICA ONLY', 'ALWAYS']);
    expectSqlContains(EventTriggerSQL.getDefinition('ddl_logger'), ['pg_get_functiondef', "WHERE evtname = 'ddl_logger'"]);
    expectSqlContains(EventTriggerSQL.create(), ['CREATE EVENT TRIGGER trigger_name', 'ON ddl_command_end']);
    expect(EventTriggerSQL.drop('ddl_logger')).to.equal('DROP EVENT TRIGGER IF EXISTS "ddl_logger";');
    expect(EventTriggerSQL.enable('ddl_logger')).to.equal('ALTER EVENT TRIGGER "ddl_logger" ENABLE;');
    expect(EventTriggerSQL.disable('ddl_logger')).to.equal('ALTER EVENT TRIGGER "ddl_logger" DISABLE;');
    expect(EventTriggerSQL.enableAlways('ddl_logger')).to.equal('ALTER EVENT TRIGGER "ddl_logger" ENABLE ALWAYS;');
    expect(EventTriggerSQL.enableReplica('ddl_logger')).to.equal('ALTER EVENT TRIGGER "ddl_logger" ENABLE REPLICA;');
  });

  it('covers standalone table profile SQL helpers', () => {
    expect(ProfileSQL.tableStats(schema, table)).to.contain('pg_stat_user_tables');
    expect(ProfileSQL.columnStats(schema, table)).to.contain('pg_stats');
    expect(ProfileSQL.columnDetails(schema, table)).to.contain('pg_attribute');
    expect(ProfileSQL.tableActivity(schema, table)).to.contain('seq_scan');
    expect(ProfileSQL.indexUsage(schema, table)).to.contain('pg_stat_user_indexes');
    expect(ProfileSQL.dataSample(schema, table, column)).to.contain('LIMIT 10');
    expect(ProfileSQL.dataSample(schema, table, column, 5)).to.contain('LIMIT 5');
  });

  it('covers table, view, column, index, constraint, extension, type and role SQL builders', () => {
    expect(TableSQL.select(schema, table)).to.equal('SELECT * FROM "public"."users" LIMIT 100;');
    expect(TableSQL.select(schema, table, 25)).to.contain('LIMIT 25;');
    expectSqlContains(TableSQL.insert(schema, table), ['INSERT INTO "public"."users"', 'RETURNING *;']);
    expectSqlContains(TableSQL.update(schema, table), ['UPDATE "public"."users"', 'RETURNING *;']);
    expectSqlContains(TableSQL.delete(schema, table), ['DELETE FROM "public"."users"', 'RETURNING *;']);
    expectSqlContains(TableSQL.truncate(schema, table), ['TRUNCATE TABLE "public"."users";']);
    expectSqlContains(TableSQL.drop(schema, table), ['DROP TABLE "public"."users";']);
    expectSqlContains(TableSQL.vacuum(schema, table), ['VACUUM (VERBOSE, ANALYZE) "public"."users";']);
    expectSqlContains(TableSQL.analyze(schema, table), ['ANALYZE VERBOSE "public"."users";']);
    expectSqlContains(TableSQL.reindex(schema, table), ['REINDEX TABLE "public"."users";']);
    expectSqlContains(TableSQL.createScript(schema, table), ['CREATE TABLE "public"."users"', 'COMMENT ON TABLE "public"."users"']);

    expect(ViewSQL.select(schema, 'orders_view')).to.contain('SELECT * FROM "public"."orders_view" LIMIT 100;');
    expectSqlContains(ViewSQL.createOrReplace(schema, 'orders_view'), ['CREATE OR REPLACE VIEW "public"."orders_view" AS', 'COMMENT ON VIEW "public"."orders_view"']);
    expectSqlContains(ViewSQL.drop(schema, 'orders_view'), ['DROP VIEW "public"."orders_view";']);
    expectSqlContains(ViewSQL.definition(schema, 'orders_view'), ['FROM pg_views', 'information_schema.view_column_usage']);

    expect(ColumnSQL.select(schema, table, column)).to.contain('SELECT email');
    expect(ColumnSQL.select(schema, table, column, 5)).to.contain('LIMIT 5;');
    expectSqlContains(ColumnSQL.alter(schema, table, column), ['ALTER TABLE public.users', 'SET DEFAULT']);
    expectSqlContains(ColumnSQL.drop(schema, table, column), ['DROP COLUMN email']);
    expectSqlContains(ColumnSQL.rename(schema, table, 'old_name', 'new_name'), ['RENAME COLUMN old_name TO new_name']);
    expectSqlContains(ColumnSQL.createIndex(schema, table, column, indexName), ['CREATE INDEX users_email_idx', 'WHERE email IS NOT NULL']);

    expectSqlContains(IndexSQL.drop(schema, indexName), ['DROP INDEX "public"."users_email_idx";']);
    expectSqlContains(IndexSQL.reindex(schema, indexName), ['REINDEX INDEX "public"."users_email_idx";']);
    expectSqlContains(IndexSQL.alter(schema, indexName), ['ALTER INDEX "public"."users_email_idx" RENAME TO new_index_name;']);
    expectSqlContains(IndexSQL.usageStats(schema, indexName), ['pg_stat_user_indexes', 'usage_status']);

    expectSqlContains(ConstraintSQL.addPrimaryKey(schema, table), ['PRIMARY KEY (id)']);
    expectSqlContains(ConstraintSQL.addForeignKey(schema, table), ['FOREIGN KEY (reference_id)', 'ON DELETE CASCADE']);
    expectSqlContains(ConstraintSQL.addUnique(schema, table), ['UNIQUE (email)']);
    expectSqlContains(ConstraintSQL.addCheck(schema, table), ['CHECK (status IN']);
    expectSqlContains(ConstraintSQL.drop(schema, table, 'users_email_key'), ['DROP CONSTRAINT "users_email_key";']);
    expectSqlContains(ConstraintSQL.validate(schema, table, 'users_email_key'), ['VALIDATE CONSTRAINT "users_email_key";']);

    expectSqlContains(ExtensionSQL.enable('uuid-ossp'), ['CREATE EXTENSION IF NOT EXISTS "uuid-ossp";']);
    expectSqlContains(ExtensionSQL.drop('uuid-ossp'), ['DROP EXTENSION IF EXISTS "uuid-ossp";']);
    expectSqlContains(ExtensionSQL.dropCascade('uuid-ossp'), ['DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;']);

    expectSqlContains(FunctionSQL.call(schema, 'calc_total', '1, 2'), ['SELECT public.calc_total(1, 2);']);
    expectSqlContains(FunctionSQL.createOrReplace(schema), ['CREATE OR REPLACE FUNCTION public.function_name', 'LANGUAGE sql']);
    expectSqlContains(FunctionSQL.drop(schema, 'calc_total', 'integer'), ['DROP FUNCTION IF EXISTS public.calc_total(integer);']);
    expectSqlContains(FunctionSQL.metadata(schema, 'calc_total'), ['pg_get_function_arguments', 'pg_language']);

    expectSqlContains(SchemaSQL.create(), ['CREATE SCHEMA schema_name;']);
    expectSqlContains(SchemaSQL.drop(schema), ['DROP SCHEMA public;']);
    expectSqlContains(SchemaSQL.grant(schema), ['GRANT USAGE ON SCHEMA public TO role_name;']);
    expectSqlContains(SchemaSQL.listObjects(schema), ['object_type', 'pg_class c']);

    expectSqlContains(TypeSQL.createComposite(schema), ['CREATE TYPE "public".type_name AS (']);
    expectSqlContains(TypeSQL.createEnum(schema), ['CREATE TYPE "public".status_enum AS ENUM']);
    expectSqlContains(TypeSQL.drop(schema, 'status_enum'), ['DROP TYPE "public"."status_enum";']);
    expectSqlContains(TypeSQL.rename(schema, 'status_enum'), ['ALTER TYPE "public"."status_enum" RENAME TO new_type_name;']);
    expectSqlContains(TypeSQL.findUsage(schema, 'status_enum'), ['FROM pg_attribute a']);

    expectSqlContains(UserRoleSQL.createUser('app_db'), ['CREATE USER new_username WITH', 'GRANT CONNECT ON DATABASE app_db']);
    expectSqlContains(UserRoleSQL.createRole(), ['CREATE ROLE new_role_name WITH']);
    expectSqlContains(UserRoleSQL.alterRole('app_user'), ['ALTER ROLE app_user']);
    expectSqlContains(UserRoleSQL.grant('app_user'), ['GRANT USAGE ON SCHEMA public TO app_user']);
    expectSqlContains(UserRoleSQL.dropRole('app_user'), ['DROP ROLE app_user;']);
    expectSqlContains(UsersRolesSQL.dropRole('legacy_role'), ['DROP ROLE legacy_role;']);
  });

  it('covers materialized view and foreign table SQL builders', () => {
    expectSqlContains(MaterializedViewSQL.select(schema, 'sales_mv'), ['SELECT *', 'LIMIT 100;']);
    expectSqlContains(MaterializedViewSQL.refresh(schema, 'sales_mv'), ['REFRESH MATERIALIZED VIEW public.sales_mv;']);
    expectSqlContains(MaterializedViewSQL.create(schema, 'sales_mv'), ['CREATE MATERIALIZED VIEW public.sales_mv AS']);
    expectSqlContains(MaterializedViewSQL.drop(schema, 'sales_mv'), ['DROP MATERIALIZED VIEW public.sales_mv;']);
    expectSqlContains(MaterializedViewSQL.analyze(schema, 'sales_mv'), ['ANALYZE public.sales_mv;']);
    expectSqlContains(MaterializedViewSQL.createIndex(schema, 'sales_mv'), ['CREATE UNIQUE INDEX sales_mv_unique_idx']);

    expectSqlContains(ForeignTableSQL.queryData(schema, 'remote_users'), ['SELECT *', 'LIMIT 100;']);
    expectSqlContains(ForeignTableSQL.edit(schema, 'remote_users'), ['DROP FOREIGN TABLE IF EXISTS public.remote_users;', 'CREATE FOREIGN TABLE public.remote_users']);
    expectSqlContains(ForeignTableSQL.drop(schema, 'remote_users'), ['DROP FOREIGN TABLE IF EXISTS public.remote_users;']);
    expectSqlContains(ForeignTableSQL.create.basic(schema), ['CREATE FOREIGN TABLE public.foreign_table_name']);
    expectSqlContains(ForeignTableSQL.create.postgresRemote(schema), ['CREATE EXTENSION IF NOT EXISTS postgres_fdw;']);
    expectSqlContains(ForeignTableSQL.create.fileBased(schema), ['CREATE EXTENSION IF NOT EXISTS file_fdw;']);
    expectSqlContains(ForeignTableSQL.queryWithJoin(schema), ['JOIN public.foreign_table_name ft ON lt.id = ft.id;']);
    expectSqlContains(ForeignTableSQL.manageForeignServer(), ['SELECT', 'DROP SERVER foreign_server_name CASCADE;']);
  });

  it('covers foreign data wrapper SQL builders and optional branches', () => {
    expectSqlContains(ForeignDataWrapperSQL.create.server.basic('postgres_fdw'), ['CREATE SERVER server_name', 'FOREIGN DATA WRAPPER postgres_fdw']);
    expectSqlContains(ForeignDataWrapperSQL.create.server.postgres(), ['CREATE EXTENSION IF NOT EXISTS postgres_fdw;']);
    expectSqlContains(ForeignDataWrapperSQL.create.server.mysql(), ['CREATE EXTENSION IF NOT EXISTS mysql_fdw;']);
    expectSqlContains(ForeignDataWrapperSQL.create.server.file(), ['CREATE EXTENSION IF NOT EXISTS file_fdw;']);
    expectSqlContains(ForeignDataWrapperSQL.create.server.withAuth('postgres_fdw'), ['sslmode', 'sslcert']);
    expectSqlContains(ForeignDataWrapperSQL.create.userMapping.basic('remote_server'), ['CREATE USER MAPPING FOR CURRENT_USER']);
    expectSqlContains(ForeignDataWrapperSQL.create.userMapping.withPassword('remote_server'), ['CREATE USER MAPPING FOR username']);
    expectSqlContains(ForeignDataWrapperSQL.create.userMapping.public('remote_server'), ['CREATE USER MAPPING FOR PUBLIC']);
    expectSqlContains(ForeignDataWrapperSQL.create.userMapping.withOptions('remote_server'), ['fetch_size', 'async_capable']);

    expectSqlContains(ForeignDataWrapperSQL.alter.serverOptions('remote_server'), ['ALTER SERVER remote_server']);
    expectSqlContains(ForeignDataWrapperSQL.alter.serverOwner('remote_server'), ['OWNER TO new_owner_role;']);
    expectSqlContains(ForeignDataWrapperSQL.alter.serverRename('remote_server'), ['RENAME TO new_server_name;']);
    expectSqlContains(ForeignDataWrapperSQL.alter.userMappingOptions('remote_server'), ['ALTER USER MAPPING FOR CURRENT_USER']);
    expectSqlContains(ForeignDataWrapperSQL.alter.addOption('remote_server'), ['OPTIONS (ADD option_name']);
    expectSqlContains(ForeignDataWrapperSQL.alter.dropOption('remote_server'), ['OPTIONS (DROP option_name']);

    expectSqlContains(ForeignDataWrapperSQL.query.listFDWs(), ['FROM pg_foreign_data_wrapper']);
    expectSqlContains(ForeignDataWrapperSQL.query.fdwDetails('postgres_fdw'), ["WHERE fdw.fdwname = 'postgres_fdw'"]);
    expectSqlContains(ForeignDataWrapperSQL.query.listServers(), ['-- List all foreign servers']);
    expectSqlContains(ForeignDataWrapperSQL.query.listServers('postgres_fdw'), ["WHERE fdw.fdwname = 'postgres_fdw'"]);
    expectSqlContains(ForeignDataWrapperSQL.query.serverDetails('remote_server'), ["WHERE srv.srvname = 'remote_server'"]);
    expectSqlContains(ForeignDataWrapperSQL.query.listUserMappings(), ['-- List all user mappings']);
    expectSqlContains(ForeignDataWrapperSQL.query.listUserMappings('remote_server'), ["WHERE um.srvname = 'remote_server'"]);
    expectSqlContains(ForeignDataWrapperSQL.query.userMappingDetails('remote_server', 'app_user'), ["WHERE um.srvname = 'remote_server'"]);
    expectSqlContains(ForeignDataWrapperSQL.query.foreignTablesByServer('remote_server'), ['FROM pg_foreign_table ft']);
    expectSqlContains(ForeignDataWrapperSQL.query.fdwFunctions('postgres_fdw'), ['fdwhandler::regproc']);

    expectSqlContains(ForeignDataWrapperSQL.grant.usageOnServer('remote_server', 'app_user'), ['GRANT USAGE ON FOREIGN SERVER remote_server TO app_user']);
    expectSqlContains(ForeignDataWrapperSQL.grant.usageOnFDW('postgres_fdw', 'app_user'), ['GRANT USAGE ON FOREIGN DATA WRAPPER postgres_fdw TO app_user']);

    expectSqlContains(ForeignDataWrapperSQL.drop.server('remote_server'), ['DROP SERVER IF EXISTS remote_server;']);
    expectSqlContains(ForeignDataWrapperSQL.drop.server('remote_server', true), ['DROP SERVER IF EXISTS remote_server CASCADE;']);
    expectSqlContains(ForeignDataWrapperSQL.drop.userMapping('remote_server'), ['DROP USER MAPPING IF EXISTS FOR CURRENT_USER']);
    expectSqlContains(ForeignDataWrapperSQL.drop.userMapping('remote_server', 'app_user'), ['DROP USER MAPPING IF EXISTS FOR app_user']);
    expectSqlContains(ForeignDataWrapperSQL.drop.fdw('postgres_fdw'), ['DROP FOREIGN DATA WRAPPER IF EXISTS postgres_fdw;']);
    expectSqlContains(ForeignDataWrapperSQL.drop.fdw('postgres_fdw', true), ['DROP FOREIGN DATA WRAPPER IF EXISTS postgres_fdw CASCADE;']);

    expectSqlContains(ForeignDataWrapperSQL.test.connection('remote_server'), ['BEGIN;', 'ROLLBACK;']);
    expectSqlContains(ForeignDataWrapperSQL.test.permissions('remote_server'), ['has_server_privilege']);

    expectSqlContains(ForeignDataWrapperSQL.manage.showServerOptions('remote_server'), ['unnest(srv.srvoptions)']);
    expectSqlContains(ForeignDataWrapperSQL.manage.showUserMappingOptions('remote_server'), ['unnest(um.umoptions)']);
    expectSqlContains(ForeignDataWrapperSQL.manage.showUserMappingOptions('remote_server', 'app_user'), ["AND um.usename = 'app_user'"]);
    expectSqlContains(ForeignDataWrapperSQL.manage.dependencies('remote_server'), ['CASE c.relkind']);
    expectSqlContains(ForeignDataWrapperSQL.manage.serverStatistics('remote_server'), ['COUNT(DISTINCT um.umid)']);
  });
});