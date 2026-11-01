/**
 * "The database doesn't have this yet" detection with no imports, so server code (cron, mail poll) can use it without loading the
 * browser Supabase client that lib/db-features.ts creates at import. lib/db-features.ts re-exports these unchanged.
 */

/**
 * PostgREST / Postgres codes for a function, table or column that doesn't exist (yet):
 * PGRST202 function not in the schema cache, PGRST204 column not in the schema cache, PGRST205 table not in the schema cache,
 * 42883 undefined function, 42P01 undefined table, 42703 undefined column.
 */
export const MISSING_DB_OBJECT_CODES: ReadonlySet<string> = new Set(["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"]);

export const NEEDS_DATABASE_UPDATE = "This needs a database update that hasn't been applied yet.";

/** True when the error says the database doesn't have the function, table or column (the migration isn't applied). */
export function missingDbObject(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code && MISSING_DB_OBJECT_CODES.has(error.code)) return true;
  return /could not find the .* in the schema cache|(function|relation|column) .* does not exist/i.test(error.message ?? "");
}
