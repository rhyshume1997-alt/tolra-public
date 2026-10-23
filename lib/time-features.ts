/**
 * Is the database ready for hours and job sheets (migrations 050 to 052)? The app is deployed when it is merged; Rhys applies the SQL
 * later. Until then every time page and the settings card say so, show no Clock in/out and no Save, and nothing is queued on the device
 * for a server that can't take it. Same approach as lib/db-features (067's branch): tell "the database doesn't have this yet" apart
 * from a real error, so everything else keeps working.
 */
import { supabase } from "@/lib/supabase";

export const TIME_NEEDS_DATABASE_UPDATE = "Hours and job sheets need a database update. Nothing is recorded until it has been applied.";
export const TIME_NOT_CHECKED = "Tolra hasn't been able to check the database for hours yet. Connect to the internet once, then try again.";

/**
 * PostgREST / Postgres codes for a function, table or column that doesn't exist (yet): PGRST202 function, PGRST204 column, PGRST205
 * table not in the schema cache; 42883 undefined function, 42P01 undefined table, 42703 undefined column.
 */
export const MISSING_DB_OBJECT_CODES: ReadonlySet<string> = new Set(["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"]);

type DbError = { code?: string | null; message?: string | null } | null | undefined;

/** True when the error says the database doesn't have the function, table or column (the migration isn't applied). */
export function missingDbObject(error: DbError): boolean {
  if (!error) return false;
  if (error.code && MISSING_DB_OBJECT_CODES.has(error.code)) return true;
  return /could not find the .* in the schema cache|(function|relation|column) .* does not exist/i.test(error.message ?? "");
}

/** true: present; false: the database doesn't have it; null: no answer (offline, a timeout), ask again later. */
export function featurePresent(result: { error: DbError }): boolean | null {
  if (!result.error) return true;
  return missingDbObject(result.error) ? false : null;
}

type Probe = { from: (table: string) => { select: (columns: string) => { limit: (n: number) => PromiseLike<{ error: DbError }> } } };
const SEEN_KEY = "tolra.db.time-050-052";
let cached: boolean | null = null;
let cachedAt = 0;
/** "Not yet" is asked again after this long, so a page left open picks up the SQL once it is applied. "Present" is kept. */
export const MISSING_RECHECK_MS = 60_000;
let pending: Promise<boolean | null> | null = null;

function seenOnThisDevice(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberSeen(present: boolean) {
  try {
    if (typeof localStorage === "undefined") return;
    if (present) localStorage.setItem(SEEN_KEY, "1");
    else localStorage.removeItem(SEEN_KEY);
  } catch {
    // Private window or blocked storage: the in-memory answer is enough.
  }
}

/**
 * Asks the database once per page load: a one-row read of time_week_approvals (052, the last of the three, which needs 050 and 051 in
 * place). Row rules make it return at most the caller's own rows. A missing table means "not yet"; any other failure is no answer.
 */
export async function databaseHasTime(client: Probe | null = supabase as unknown as Probe | null, now = Date.now()): Promise<boolean | null> {
  if (cached === true || (cached === false && now - cachedAt < MISSING_RECHECK_MS)) return cached;
  if (!client) return null;
  pending ??= (async () => {
    try {
      const present = featurePresent(await client.from("time_week_approvals").select("id").limit(1));
      if (present !== null) {
        cached = present;
        cachedAt = now;
        rememberSeen(present);
      }
      return present;
    } catch {
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/**
 * Whether a clock action or job Start/Stop may be queued on this device: only once the database is known to have 050 to 052 (asked now,
 * or seen on this device before when it can't be asked now, offline). Never queued for a server that would refuse it.
 */
export async function timeOpsAllowed(client?: Probe | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  const present = await databaseHasTime(client);
  if (present === true) return { ok: true };
  if (present === false) return { ok: false, reason: TIME_NEEDS_DATABASE_UPDATE };
  return seenOnThisDevice() ? { ok: true } : { ok: false, reason: TIME_NOT_CHECKED };
}

/** For tests: forget the cached answer (and what this device remembers). */
export function resetTimeFeatureCache() {
  cached = null;
  cachedAt = 0;
  pending = null;
  rememberSeen(false);
}
