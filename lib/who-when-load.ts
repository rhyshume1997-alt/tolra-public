/**
 * Loading for the who/when lines (components/who-when.tsx), kept out of the component so it can be tested.
 *
 * The component shows nothing until it has both the record and the company's people. Before this, one failed or rejected read
 * (a request lost while the sign-in was still settling, a busy database) left it empty for the life of the dialog: nothing
 * re-ran the load. loadWhoWhen reports a failed read as null, and withRetries asks again a few times before giving up.
 */
import { type JobExtras, type PaymentRow, type PeopleMap, WHO_COLUMNS } from "@/lib/people";
import { loadCompanyPeople } from "@/lib/company-people";
import type { supabase } from "@/lib/supabase";

type Client = NonNullable<typeof supabase>;

export type WhoWhenData = { record: Record<string, unknown>; people: PeopleMap; payments: PaymentRow[]; extras: JobExtras };

/** Waits before each further attempt after the first one fails (ms): the lines are on screen well inside a test's 20 s. */
export const WHO_WHEN_RETRY_MS = [400, 1200, 3000] as const;

/** The record, the people and the extras, or null when the record or the people couldn't be read (the caller may try again). */
export async function loadWhoWhen(client: Client, table: string, id: string, row: Record<string, unknown> | null | undefined, usernames: boolean): Promise<WhoWhenData | null> {
  const [rec, who, paid, reworks, scrap] = await Promise.all([
    row ? Promise.resolve({ data: row, error: null }) : client.from(table).select(WHO_COLUMNS[table]).eq("id", id).maybeSingle(),
    loadCompanyPeople(client, { usernames }),
    table === "invoices" ? client.from("invoice_payments").select("created_by, created_at, reverses_payment_id").eq("invoice_id", id).order("created_at").order("id") : Promise.resolve({ data: [], error: null }),
    // A job's failed inspections and rework (migration 037); before that update the tables are absent and these lines are simply left out.
    table === "jobs" ? client.from("job_rework").select("id, inspection_id, follow_up_of, raised_by, raised_at, started_by, started_at, finished_by, finished_at").eq("job_id", id).order("raised_at") : Promise.resolve({ data: [], error: null }),
    table === "jobs" ? client.from("job_rework_entries").select("id, created_by, created_at, quantity").eq("job_id", id).eq("kind", "scrap").order("created_at") : Promise.resolve({ data: [], error: null }),
  ]);
  // Before the database update (035) there is nothing to show: say nothing rather than guess.
  if (!who || rec.error || !rec.data) return null;
  return {
    record: rec.data as unknown as Record<string, unknown>,
    people: who,
    payments: (paid.data ?? []) as PaymentRow[],
    extras: { reworks: reworks.error ? [] : ((reworks.data ?? []) as JobExtras["reworks"]), scrap: scrap.error ? [] : ((scrap.data ?? []) as JobExtras["scrap"]) },
  };
}

/**
 * Runs `load` until it gives a value, waiting delays[i] before attempt i + 2. A load that throws counts as a failed attempt.
 * Returns null when every attempt failed or `alive()` turned false (the screen moved on). `wait` is injectable for tests.
 */
export async function withRetries<T>(
  load: () => Promise<T | null>,
  alive: () => boolean,
  delays: readonly number[] = WHO_WHEN_RETRY_MS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T | null> {
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (!alive()) return null;
    try {
      const value = await load();
      if (!alive()) return null;
      if (value) return value;
    } catch {
      // a lost request is the same as no answer: try again
    }
    if (attempt < delays.length) await wait(delays[attempt]);
  }
  return null;
}
