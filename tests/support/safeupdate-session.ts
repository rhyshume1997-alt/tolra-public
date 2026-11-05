/**
 * pg-safeupdate for the DB tests' stand-in clients (e2-pg-client, wa-pg-client). Supabase preloads it into every API session so a bare
 * UPDATE or DELETE is refused. A direct test session can only LOAD it where this database user may: a superuser, or the library under
 * $libdir/plugins. On the Supabase CLI stack the `postgres` role is not a superuser and `LOAD 'safeupdate'` is refused (SQLSTATE 42501,
 * "access to library ... is not allowed"; CI run 42102984212: 35 failures from this one line). Order tried: the plain name, then the
 * plugins path. Only 42501 is tolerated, and never silently: the session is counted and logged as running WITHOUT the guard (the same
 * situation the safeupdate-gated suites in tests/db/safeupdate-support.ts report as skipped). Any other error is thrown as before.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type Queryable = { query: (text: string) => Promise<unknown> };

export const safeupdateStatus = { loaded: 0, unavailable: 0 };
let announced = false;

export async function loadSafeupdate(db: Queryable): Promise<boolean> {
  // Attempt 1: the plain name. Refused with 42501 where the user may not LOAD it (CI run 42110687802: the CLI stack's `postgres` role).
  try {
    await db.query("load 'safeupdate'");
    safeupdateStatus.loaded += 1;
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== "42501") throw error;
  }
  // Attempt 2: the plugins path a non-superuser may load from. On the CLI stack that file does not exist (58P01 undefined_file): pg-safeupdate
  // is applied to the API role through its own `session_preload_libraries`, not placed under $libdir/plugins. Only that exact pair (42501 for
  // the plain name, then 58P01 for the plugins path) means "not loadable here"; any other error, on either attempt, is thrown.
  let refused: unknown;
  try {
    await db.query("load '$libdir/plugins/safeupdate'");
    safeupdateStatus.loaded += 1;
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== "58P01") throw error;
    refused = error;
  }
  safeupdateStatus.unavailable += 1;
  // One line per affected session, so the CI evidence can state how many sessions ran without the guard (the count is summed by ci.yml).
  try { const file = process.env.SAFEUPDATE_EVIDENCE_FILE ?? "evidence/safeupdate-sessions.log"; mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, "refused\n"); } catch { /* evidence is best effort; the counter and the log line below remain */ }
  if (!announced) {
    announced = true;
    console.log(`SAFEUPDATE-NOT-LOADABLE this database user may not LOAD pg-safeupdate (42501 then ${(refused as { code?: string }).code}); the bare UPDATE/DELETE refusal is NOT exercised in the e2/wa stand-in sessions here`);
  }
  return false;
}
