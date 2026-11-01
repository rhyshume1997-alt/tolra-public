/**
 * Clock-in network lock (migration 114, M27; Rhys 30 Oct: "an admin-only button that captures the current network IP and locks
 * clock-in to it (only admin can change)"). G21 / B40 phase 2: REFUSE, off until an admin presses Lock.
 *
 * The DATABASE decides (114's clock_in_network_lock_check on attendance_events). The address is the one the request reaches the server
 * from (075's request_client_ip: PostgREST's request.headers, cf-connecting-ip only; never an address the browser sends, never
 * x-forwarded-for). Every call here goes from the browser straight to Supabase, like 075's: "Lock clock-in to this network" therefore
 * locks to the network of the device pressing it, and the clock actions it is compared with travel the same way.
 *
 * Who is checked: EVERYONE (orchestrator decision, 30 Oct, from Rhys's wording), unless an admin marks them "Can clock in off site (while
 * the network lock is on)" in Admin > Users (114's own exception, consulted only while locked; 075's On site only flag is not used).
 * Clock in, clock out, break start and break end made online from another address are refused; from the locked network (IPv4 address,
 * or its IPv6 /64) or a saved site network (Settings > Site network) they go in. A clock action queued offline and synced later, or one
 * with no client address, can't be checked: it is accepted and marked network_unverified, listed in the week review. Corrections by
 * the office or an admin are never checked.
 *
 * clockInLockDecision mirrors the database so the Settings card can say what would happen to a clock action from this device; the
 * database decides. tests/unit/clock-in-lock.test.ts checks both against the same cases (with the SQL proof for the database side).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { featurePresent } from "@/lib/db-features";
import { onSavedNetwork, parseIp } from "@/lib/site-network";

/** The refusal's hint (114). The device holds a refused clock action as refused (never retried): see lib/offline/sync.ts clockOutcome. */
export const CLOCK_IN_NETWORK_LOCKED = "clock_in_network_locked";
/** As the database: a device time more than this far behind the server's means the action was queued offline (075's rule). */
export const SYNCED_LATER_MS = 2 * 60_000;

export type LockDecision =
  | { decision: "allowed"; why: "not_checked" | "unlocked" | "off_site_allowed" | "on_locked_network" | "on_saved_network" }
  | { decision: "unverified"; why: "synced_later" | "address_unknown" }
  | { decision: "refused"; why: "other_network" };

export type LockDecisionInput = {
  /** The company's locked network ("203.0.113.7/32", "2001:db8:1:2::/64"), or null when unlocked. */
  lockedNetwork: string | null;
  /** 075's site networks (also accepted). */
  savedNetworks: string[];
  /** 114's per-person exception: may clock in off site while the lock is on (default false). */
  offSiteAllowed: boolean;
  /** "clock" (the person's own action) or "correction" (office / admin: never checked). */
  source: "clock" | "correction";
  /** The device's time of the action (null: "now") and when the server got it. */
  deviceAt: Date | null;
  receivedAt: Date;
  /** The request's address as the server sees it (null: none). */
  ip: string | null;
};

/** What the database does with one clock action (114), in the database's order. */
export function clockInLockDecision(input: LockDecisionInput): LockDecision {
  if (input.source !== "clock") return { decision: "allowed", why: "not_checked" };
  if (!input.lockedNetwork) return { decision: "allowed", why: "unlocked" };
  if (input.offSiteAllowed) return { decision: "allowed", why: "off_site_allowed" };
  if (input.deviceAt && input.receivedAt.getTime() - input.deviceAt.getTime() > SYNCED_LATER_MS) return { decision: "unverified", why: "synced_later" };
  if (!parseIp(input.ip)) return { decision: "unverified", why: "address_unknown" };
  if (onSavedNetwork(input.ip, [input.lockedNetwork])) return { decision: "allowed", why: "on_locked_network" };
  if (onSavedNetwork(input.ip, input.savedNetworks)) return { decision: "allowed", why: "on_saved_network" };
  return { decision: "refused", why: "other_network" };
}

export const UNVERIFIED_REASON_TEXT: Record<"synced_later" | "address_unknown", string> = {
  synced_later: "synced later, network not checked",
  address_unknown: "no network address seen, not checked",
};

// ----- database calls (browser client only: the server must see the device's own address) ---------------------------------------------
type Db = SupabaseClient;
export type ClockInLock = { network: string; locked_by: string | null; locked_at: string };
export type UnverifiedClockAction = {
  event_id: string; user_id: string; action: "in" | "out" | "break_start" | "break_end"; at: string; device_at: string | null;
  received_at: string; reason: "synced_later" | "address_unknown";
};

let cached114: boolean | null = null;
let pending114: Promise<boolean> | null = null;
/**
 * Does the database have 114? A GET of at most one clock_in_network_locks row (never head-only, as the 067 probe), a table 114 creates in
 * the same transaction as everything else. Admin and office read the company's row; anyone else gets 0 rows, so any role may ask. A
 * missing table means "not yet" (the lock card and the week review notice stay hidden: nothing changes until 114 is applied); any other
 * failure is not an answer and the next call asks again.
 */
export async function databaseHas114(client: Db | null | undefined): Promise<boolean> {
  if (cached114 !== null) return cached114;
  if (!client) return false;
  pending114 ??= (async () => {
    try {
      const present = featurePresent(await client.from("clock_in_network_locks").select("organization_id").limit(1));
      if (present !== null) cached114 = present;
      return present ?? false;
    } catch {
      return false;
    } finally {
      pending114 = null;
    }
  })();
  return pending114;
}

/** The company's lock (null: unlocked). Admin and office can read it. Throws on a read error. */
export async function loadClockInLock(client: Db): Promise<ClockInLock | null> {
  const { data, error } = await client.from("clock_in_network_locks").select("network, locked_by, locked_at").maybeSingle();
  if (error) throw error;
  return (data as ClockInLock | null) ?? null;
}

async function call<T>(client: Db, fn: string): Promise<T> {
  const { data, error } = await client.rpc(fn);
  if (error) throw error;
  return data as T;
}
/** Admin, two-step: lock (or re-capture) to the network THIS request comes from. */
export const lockClockIn = (client: Db) =>
  call<{ locked: true; network: string; locked_by: string | null; locked_at: string; changed: boolean; recaptured: boolean }>(client, "lock_clock_in_network");
/** Admin, two-step: unlock. */
export const unlockClockIn = (client: Db) => call<{ locked: false; changed: boolean }>(client, "unlock_clock_in_network");
/** Admin, two-step: whether a person may clock in off site while the lock is on. */
export async function setOffSiteAllowed(client: Db, userId: string, allowed: boolean) {
  const { data, error } = await client.rpc("set_clock_in_off_site_allowed", { p_user: userId, p_allowed: allowed });
  if (error) throw error;
  return data as { user_id: string; off_site_allowed: boolean; changed: boolean };
}
/** Who may clock in off site while the lock is on (admin and office see the company's). Throws on a read error. */
export async function loadOffSiteAllowed(client: Db): Promise<Set<string>> {
  const { data, error } = await client.from("clock_in_network_exemptions").select("user_id").eq("off_site_allowed", true);
  if (error) throw error;
  return new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
}

// ----- 128: a refused clock action reported for the admin's "unrecognised network" banner ------------------------------------------------
/** How long a clock sync waits for the report's answer before carrying on (it may still land; a repeat of the key is answered). */
export const REFUSAL_REPORT_TIMEOUT_MS = 5_000;
type ReportRpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
/**
 * Tells the database about this device's own clock action that 114 refused (record_clock_in_refusal, keyed by the action's client_op_id).
 * Sent straight after the refusal, from the browser, so the database sees the same address and re-checks that it would refuse it; it
 * records nothing otherwise. Best effort: never throws and never changes the clock action's outcome; a database without 128, no
 * connection, or any refusal of the report (not_refused, too_many_refusals, ...) is ignored.
 */
export async function reportClockInRefusal(client: ReportRpc | null | undefined, op: { clientOpId: string; action: string }): Promise<boolean> {
  if (!client) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(client.rpc("record_clock_in_refusal", { p_client_op_id: op.clientOpId, p_action: op.action })).then(({ error }) => !error, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), REFUSAL_REPORT_TIMEOUT_MS); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The week's clock actions the lock could not check, [from, to). Admin and office see the company's; a person their own. Throws on error. */
export async function loadUnverifiedClockActions(client: Db, from: Date, to: Date): Promise<UnverifiedClockAction[]> {
  const { data, error } = await client.from("clock_in_network_unverified")
    .select("event_id, user_id, action, at, device_at, received_at, reason")
    .gte("at", from.toISOString()).lt("at", to.toISOString()).order("at", { ascending: true }).limit(500);
  if (error) throw error;
  return (data ?? []) as UnverifiedClockAction[];
}
