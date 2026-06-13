/** Supabase-managed schemas often clutter the explorer on Supabase connections. */
export const SUPABASE_PLATFORM_SCHEMAS = new Set([
  'auth',
  'storage',
  'realtime',
  'vault',
  'extensions',
  'pgsodium',
  'graphql',
  'graphql_public',
  'supabase_functions',
  'supabase_migrations',
]);

export function isSupabasePlatformSchema(schemaName: string): boolean {
  const lower = schemaName.toLowerCase();
  if (SUPABASE_PLATFORM_SCHEMAS.has(lower)) {
    return true;
  }
  return lower.startsWith('supabase_') || lower.startsWith('graphql');
}
