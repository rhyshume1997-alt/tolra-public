/**
 * Clock-in network lock (migration 114, M27), the app side:
 *   * clockInLockDecision (the Settings card's "would a clock-in from here go in?") mirrors the database's check: unlocked / locked,
 *     the default person (refused) / a person allowed off site, same / other address, IPv4, IPv6 /64, IPv4-mapped, a saved site network, synced later (more
 *     than 2 minutes behind), no or unreadable address, and corrections never checked. The database side is proved by
 *     tests/scripts/clock-in-network-lock-114.proof.sql (tests/db/clock-in-network-lock-114.test.ts in CI).
 *   * the address the lock compares is the request's as the SERVER saw it: the migration reads only 075's request_client_ip()
 *     (cf-connecting-ip) and never x-forwarded-for, and both admin functions go through 075's admin + two-step guard.
 *   * the database's refusal reaches the person as a refusal (held, not retried as "no connection"), with its own words.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CLOCK_IN_NETWORK_LOCKED, type LockDecisionInput, REFUSAL_REPORT_TIMEOUT_MS, clockInLockDecision, reportClockInRefusal } from "@/lib/clock-in-lock";
import { friendlyError } from "@/lib/friendly-error";
import type { ClockOp } from "@/lib/offline/outbox";
import { isNetworkError } from "@/lib/offline/store";
import { executeClockOp } from "@/lib/offline/sync";

const MIGRATION = readFileSync(path.resolve(__dirname, "../../supabase/migrations/114_clock_in_network_lock.sql"), "utf8");
const now = new Date("2026-10-30T08:00:00Z");
const base: LockDecisionInput = {
  lockedNetwork: "203.0.113.7/32", savedNetworks: [], offSiteAllowed: false, source: "clock", deviceAt: null, receivedAt: now, ip: "203.0.113.7",
};
const decide = (over: Partial<LockDecisionInput>) => clockInLockDecision({ ...base, ...over });
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

describe("clockInLockDecision mirrors the database", () => {
  it("unlocked: nobody is refused, exception or not", () => {
    expect(decide({ lockedNetwork: null, ip: "198.51.100.9" })).toEqual({ decision: "allowed", why: "unlocked" });
    expect(decide({ lockedNetwork: null, ip: "198.51.100.9", offSiteAllowed: true })).toEqual({ decision: "allowed", why: "unlocked" });
  });
  it("locked, the default person (no exception): the locked address goes in, another is refused", () => {
    expect(decide({})).toEqual({ decision: "allowed", why: "on_locked_network" });
    expect(decide({ ip: "198.51.100.9" })).toEqual({ decision: "refused", why: "other_network" });
    expect(decide({ ip: "203.0.113.8" })).toEqual({ decision: "refused", why: "other_network" });
  });
  it("locked, a person allowed off site: not checked", () => {
    expect(decide({ offSiteAllowed: true, ip: "198.51.100.9" })).toEqual({ decision: "allowed", why: "off_site_allowed" });
    expect(decide({ offSiteAllowed: true, ip: null, deviceAt: secondsAgo(600) })).toEqual({ decision: "allowed", why: "off_site_allowed" });
  });
  it("a correction by the office or an admin is never checked", () => {
    expect(decide({ source: "correction", ip: "198.51.100.9" })).toEqual({ decision: "allowed", why: "not_checked" });
  });
  it("IPv4-mapped IPv6 is the IPv4 address", () => {
    expect(decide({ ip: "::ffff:203.0.113.7" })).toEqual({ decision: "allowed", why: "on_locked_network" });
  });
  it("IPv6: any address in the locked /64 goes in, another /64 is refused", () => {
    const v6 = { lockedNetwork: "2001:db8:1:2::/64" };
    expect(decide({ ...v6, ip: "2001:db8:1:2:abcd::99" })).toEqual({ decision: "allowed", why: "on_locked_network" });
    expect(decide({ ...v6, ip: "2001:db8:1:3::1" })).toEqual({ decision: "refused", why: "other_network" });
    expect(decide({ ...v6, ip: "203.0.113.7" })).toEqual({ decision: "refused", why: "other_network" });
  });
  it("a saved site network is accepted too", () => {
    expect(decide({ ip: "192.0.2.44", savedNetworks: ["192.0.2.0/24"] })).toEqual({ decision: "allowed", why: "on_saved_network" });
  });
  it("no address, or one that isn't an address (e.g. a forwarded list): kept, marked unverified", () => {
    for (const ip of [null, "", "  ", "not-an-ip", "198.51.100.9, 203.0.113.7"]) {
      expect(decide({ ip })).toEqual({ decision: "unverified", why: "address_unknown" });
    }
  });
  it("synced later (device time more than 2 minutes behind): kept, marked unverified, whatever the address", () => {
    expect(decide({ deviceAt: secondsAgo(121), ip: "198.51.100.9" })).toEqual({ decision: "unverified", why: "synced_later" });
    expect(decide({ deviceAt: secondsAgo(600), ip: "203.0.113.7" })).toEqual({ decision: "unverified", why: "synced_later" });
    // At most 2 minutes behind is online: checked.
    expect(decide({ deviceAt: secondsAgo(90), ip: "198.51.100.9" })).toEqual({ decision: "refused", why: "other_network" });
    expect(decide({ deviceAt: secondsAgo(120), ip: "198.51.100.9" })).toEqual({ decision: "refused", why: "other_network" });
    // A device clock ahead of the server is online too.
    expect(decide({ deviceAt: secondsAgo(-300), ip: "198.51.100.9" })).toEqual({ decision: "refused", why: "other_network" });
  });
});

describe("the migration: where the address comes from, and who may lock", () => {
  const body = (fn: string) => {
    const m = MIGRATION.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?\\n\\$\\$;`));
    if (!m) throw new Error(`${fn} not found`);
    return m[0];
  };
  it("reads the address only through 075's request_client_ip (cf-connecting-ip), never x-forwarded-for", () => {
    const code = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/x-forwarded-for|x-real-ip|request\.headers/i);
    expect(body("lock_clock_in_network")).toContain("public.request_client_ip()");
    expect(body("clock_in_network_lock_check")).toContain("public.request_client_ip()");
  });
  it("lock, unlock and the off-site exception are admin only, with the two-step check (075's site_network_admin_org)", () => {
    for (const fn of ["lock_clock_in_network", "unlock_clock_in_network"]) {
      expect(body(fn)).toMatch(/v_org\s+UUID := public\.site_network_admin_org\(\);/);
      expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon;`);
    }
    const setException = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.set_clock_in_off_site_allowed\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(setException).toMatch(/v_org\s+UUID := public\.site_network_admin_org\(\);/);
    expect(MIGRATION).toContain("REVOKE ALL ON FUNCTION public.set_clock_in_off_site_allowed(UUID, BOOLEAN) FROM PUBLIC, anon;");
  });
  it("the lock covers everyone: the check consults only 114's exception, never 075's On site only flag", () => {
    expect(body("clock_in_network_lock_check")).not.toMatch(/site_network_members|on_site_only/);
    expect(body("clock_in_network_lock_check")).toMatch(/IF EXISTS \(SELECT 1 FROM public\.clock_in_network_exemptions x[\s\S]*?x\.off_site_allowed\) THEN\s+RETURN NEW;/);
    expect(MIGRATION).toMatch(/off_site_allowed BOOLEAN NOT NULL DEFAULT FALSE/);
  });
});

describe("the refusal reaches the person as a refusal", () => {
  const message = (() => {
    const m = MIGRATION.match(/RAISE EXCEPTION '% (from the workshop [^']*(?:''[^']*)*)'/);
    if (!m) throw new Error("refusal message not found");
    return `Clock in ${m[1].replace(/''/g, "'")}`;
  })();
  const error = { code: "42501", hint: CLOCK_IN_NETWORK_LOCKED, message };

  it("is not read as a lost connection (so the device doesn't retry it until it counts as synced later)", () => {
    expect(message).toMatch(/^Clock in from the workshop /);
    expect(isNetworkError(error)).toBe(false);
  });
  it("shows the database's own words", () => {
    expect(friendlyError(error, "fallback")).toBe(message);
  });
  it("executeClockOp holds it as rejected (not network, not blocked)", async () => {
    const client = { rpc: async () => ({ data: null, error }) };
    const op: ClockOp = { kind: "clock", v: 1, action: "in", at: now.toISOString(), clientOpId: "00000000-0000-0000-0000-000000000114", device: "Phone", jobNo: "Daily job sheet" };
    const outcome = await executeClockOp(op, client as never, "o1");
    expect(outcome).toMatchObject({ status: "rejected", reason: message });
  });
  it("128: the refusal is reported (record_clock_in_refusal, the action's own key) and the outcome is the same whatever the report answers", async () => {
    const op: ClockOp = { kind: "clock", v: 1, action: "break_start", at: now.toISOString(), clientOpId: "00000000-0000-0000-0000-000000000128", device: "Phone", jobNo: "Daily job sheet" };
    for (const report of [{ data: { recorded: true }, error: null }, { data: null, error: { code: "PGRST202", message: "no function" } }]) {
      const calls: [string, unknown][] = [];
      const client = { rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return fn === "record_clock_in_refusal" ? report : { data: null, error }; } };
      expect(await executeClockOp(op, client as never, "o1")).toMatchObject({ status: "rejected", code: "refused", reason: message });
      expect(calls.filter(([fn]) => fn === "record_clock_in_refusal")).toEqual([["record_clock_in_refusal", { p_client_op_id: op.clientOpId, p_action: "break_start" }]]);
    }
  });
  it("128: no report for any other refusal", async () => {
    const calls: string[] = [];
    const client = { rpc: async (fn: string) => { calls.push(fn); return { data: null, error: { code: "22023", hint: "bad_action", message: "Unknown" } }; } };
    const op: ClockOp = { kind: "clock", v: 1, action: "in", at: now.toISOString(), clientOpId: "00000000-0000-0000-0000-000000000129", device: "Phone", jobNo: "Daily job sheet" };
    await executeClockOp(op, client as never, "o1");
    expect(calls).not.toContain("record_clock_in_refusal");
  });
  it("128: reportClockInRefusal never throws and gives up after its timeout", async () => {
    expect(await reportClockInRefusal(null, { clientOpId: "k", action: "in" })).toBe(false);
    expect(await reportClockInRefusal({ rpc: () => { throw new Error("boom"); } }, { clientOpId: "k", action: "in" })).toBe(false);
    vi.useFakeTimers();
    try {
      const pending = reportClockInRefusal({ rpc: () => new Promise(() => {}) }, { clientOpId: "k", action: "in" });
      await vi.advanceTimersByTimeAsync(REFUSAL_REPORT_TIMEOUT_MS);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
