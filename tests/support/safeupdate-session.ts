/**
 * pg-safeupdate for the DB tests' stand-in clients (e2-pg-client, wa-pg-client). Supabase preloads it into every API session so a bare
 * UPDATE or DELETE is refused. A direct test session can only LOAD it where this database user may: a superuser, or the library under
 * $libdir/plugins. On the Supabase CLI stack the `postgres` role is not a superuser and `LOAD 'safeupdate'` is refused (SQLSTATE 42501,
 * "access to library ... is not allowed"; CI run 42102984212: 35 failures from this one line). Order tried: the plain name, then the
 * plugins path. Only 42501 is tolerated, and never silently: the session is counted and logged as running WITHOUT the guard (the same
 * situation the safeupdate-gated suites in tests/db/safeupdate-support.ts report as skipped). Any other error is thrown as before.
 */
type Queryable = { query: (text: string) => Promise<unknown> };

export const safeupdateStatus = { loaded: 0, unavailable: 0 };
let announced = false;

export async function loadSafeupdate(db: Queryable): Promise<boolean> {
  let refused: unknown;
  for (const library of ["safeupdate", "$libdir/plugins/safeupdate"]) {
    try {
      await db.query(`load '${library}'`);
      safeupdateStatus.loaded += 1;
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== "42501") throw error;
      refused = error;
    }
  }
  safeupdateStatus.unavailable += 1;
  if (!announced) {
    announced = true;
    console.log(`SAFEUPDATE-NOT-LOADABLE this database user may not LOAD pg-safeupdate (${(refused as { code?: string }).code}); the bare UPDATE/DELETE refusal is NOT exercised in the e2/wa stand-in sessions here`);
  }
  return false;
}
