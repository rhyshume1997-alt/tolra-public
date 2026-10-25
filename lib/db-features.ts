/**
 * The app can be deployed before a migration is applied (Rhys applies the SQL later). These helpers let a feature tell "the database
 * doesn't have this yet" apart from a real error, so it can hide itself or say "needs a database update" while everything that
 * existed before keeps working.
 */
import { supabase } from "@/lib/supabase";

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

/**
 * The answer to "does the database have 067?" from a probe that reads at most one row of document_attachments (as a GET), which 067
 * creates in the same transaction as everything else it adds (quote_attachments.kind, replace_draft_invoice,
 * link_delivery_note_to_invoice, job_file_quote_reference_ok). Any role may ask (row rules just give 0 rows). A missing table means
 * "not yet"; any other failure (offline, a timeout) is not an answer, so the feature is not hidden for it and the next call asks again.
 */
export type ProbeResult = { error: { code?: string | null; message?: string | null } | null };
export function featurePresent(result: ProbeResult): boolean | null {
  if (!result.error) return true;
  return missingDbObject(result.error) ? false : null;
}

let cached067: boolean | null = null;
let pending067: Promise<boolean> | null = null;

export async function databaseHas067(): Promise<boolean> {
  if (cached067 !== null) return cached067;
  if (!supabase) return false;
  pending067 ??= (async () => {
    try {
      // A GET, never a head-only count. On a HEAD request PostgREST sends no body, and supabase-js turns a 404 with an empty body into
      // "204, no error", so a missing table would read as present (tests/unit/db-probe-get.test.ts).
      const result = await supabase!.from("document_attachments").select("id").limit(1);
      const present = featurePresent(result);
      if (present !== null) cached067 = present;
      return present ?? true;
    } catch {
      return true;
    } finally {
      pending067 = null;
    }
  })();
  return pending067;
}

let cached068: boolean | null = null;
let pending068: Promise<boolean> | null = null;

/**
 * "Does the database have 068?" (quote versions, partial acceptance, part / drawing / revision per line). A GET of at most one
 * row's quote_line_items.declined (never head-only: a HEAD carries no error body, so supabase-js would read a missing column as
 * present; tests/unit/db-probe-get.test.ts), which 068 adds in the same transaction as everything else (revise_quote, accept_quote's
 * p_lines, the part columns). A missing column (42703 / PGRST204) means "not yet": the quote screens then read and write only what
 * existed before. Any other failure is not an answer: the features stay on and the next call asks again.
 */
export async function databaseHas068(): Promise<boolean> {
  if (cached068 !== null) return cached068;
  if (!supabase) return false;
  pending068 ??= (async () => {
    try {
      const result = await supabase!.from("quote_line_items").select("declined").limit(1);
      const present = featurePresent(result);
      if (present !== null) cached068 = present;
      return present ?? true;
    } catch {
      return true;
    } finally {
      pending068 = null;
    }
  })();
  return pending068;
}

/**
 * Does the database have 073 (invoice screen: void_invoice, £0 text lines, invoice note, delivery address, customer mobile)? A GET of
 * invoices.invoice_note, at most one row (never a head-only count: see the 067 probe above), a column 073 adds in the same
 * transaction as everything else
 * (void_invoice, invoices_void_guard, check_invoice_line, invoices.delivery_address, customers.mobile). Admin and office ask it (the
 * screens that use it are theirs); other roles just get 0 rows. A missing column means "not yet"; any other failure (offline, a
 * timeout) is not an answer: the feature stays hidden for that call (it writes, so it waits for a real yes) and the next call asks again.
 */
let cached073: boolean | null = null;
let pending073: Promise<boolean> | null = null;

export async function databaseHas073(): Promise<boolean> {
  if (cached073 !== null) return cached073;
  if (!supabase) return false;
  pending073 ??= (async () => {
    try {
      // A GET: a missing column comes back as 400 with 42703 (or PGRST204), which a HEAD request would lose.
      const result = await supabase!.from("invoices").select("invoice_note").limit(1);
      const present = featurePresent(result);
      if (present !== null) cached073 = present;
      return present ?? false;
    } catch {
      return false;
    } finally {
      pending073 = null;
    }
  })();
  return pending073;
}

/**
 * Does the database have 075 (site network check, phase 1; refused late time actions reported to the office)? A GET of
 * time_sync_rejections.id, at most one row (never a head-only count: see the 067 probe above), a table 075 adds in the same transaction
 * as everything else (site_networks, site_network_settings, site_network_members, the clock check, report/resolve). Row rules return
 * at most the caller's own rows (admin and office: the company's), so every role can ask. A missing table means "not yet"; any other
 * failure is not an answer: the feature stays hidden for that call and the next call asks again.
 */
let cached075: boolean | null = null;
let pending075: Promise<boolean> | null = null;

export async function databaseHas075(): Promise<boolean> {
  if (cached075 !== null) return cached075;
  if (!supabase) return false;
  pending075 ??= (async () => {
    try {
      const result = await supabase!.from("time_sync_rejections").select("id").limit(1);
      const present = featurePresent(result);
      if (present !== null) cached075 = present;
      return present ?? false;
    } catch {
      return false;
    } finally {
      pending075 = null;
    }
  })();
  return pending075;
}

/**
 * "Does the database have 084?" (Xero + Integrations, G22). A GET of at most one integration_mappings row, which 084 creates in the same
 * transaction as everything else (connections, the send log, integration_overview, integration_set_mapping, integration_retry_send). Row
 * rules give the company's admins its rows and everyone else none, so any role may ask. A missing table means "not yet": the Integrations
 * link and page stay hidden. Any other failure (offline, a timeout) is not an answer: as for 067 and 068 the feature is not hidden for it
 * (the page's own integration_overview call then says "not yet" only on a missing object) and the next call asks again.
 */
let cached084: boolean | null = null;
let pending084: Promise<boolean> | null = null;

export async function databaseHas084(): Promise<boolean> {
  if (cached084 !== null) return cached084;
  if (!supabase) return false;
  pending084 ??= (async () => {
    try {
      const present = featurePresent(await supabase!.from("integration_mappings").select("id").limit(1));
      if (present !== null) cached084 = present;
      return present ?? true;
    } catch {
      return true;
    } finally {
      pending084 = null;
    }
  })();
  return pending084;
}

/** For tests: forget the cached answers. */
export function resetDatabaseFeatureCache() {
  cached067 = null;
  pending067 = null;
  cached068 = null;
  pending068 = null;
  cached073 = null;
  pending073 = null;
  cached075 = null;
  pending075 = null;
  cached084 = null;
  pending084 = null;
}
