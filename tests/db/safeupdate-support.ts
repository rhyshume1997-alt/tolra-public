/**
 * pg-safeupdate in a direct session, shared by the import suites that load it (079's data-import-safeupdate, 085's data-import-pr2):
 * Supabase loads it into every API session; a direct test session loads it only where this database user may.
 */
import { withDb } from "../support/fixtures";

/** Whether this database user may LOAD safeupdate into its own session (superuser, or the library under $libdir/plugins). */
export const LOADABLE = await withDb(async (db) => {
  try {
    await db.query("LOAD 'safeupdate'");
    return (await db.query<{ v: string | null }>("select current_setting('safeupdate.enabled', true) as v")).rows[0].v === "on";
  } catch {
    return false;
  }
}).catch(() => false);
