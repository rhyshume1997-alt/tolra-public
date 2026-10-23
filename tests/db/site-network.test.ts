/**
 * Site network check, phase 1 (migration 075, B40 / G21): RECORD AND FLAG ONLY, off by default.
 *
 *   * defaults (switch off, nobody on-site-only, or the switch off with an on-site-only person): a clock action writes nothing new, its
 *     answer and its audit rows are exactly 050's;
 *   * switch 'flag' and an on-site-only person: the request's IP (PostgREST request.headers, cf-connecting-ip only) inside a saved
 *     network (IPv4, IPv6 /64, an IPv4-mapped address) is 'on_site'; outside, 'off_site' and flagged, NEVER refused; no header 'unknown';
 *     a device time more than 2 minutes behind (queued offline, synced later) 'synced_later' with no IP; x-forwarded-for ignored;
 *     corrections and people who may work off site never checked; an error inside the check never refuses the clock action;
 *   * admin only, keyed and audited: the switch, networks (typed, or "the network I'm on now"), the person flag; office, workshop and
 *     viewer refused; a replay answers the first result, a key reused for something else is refused;
 *   * reads: admin and office see the networks, the flags and every check row; workshop only their own flag and check rows; viewer and
 *     the other company nothing; no direct writes.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

import { type Who, become, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

/** Runs `fn` as `who` in one committed transaction, with the request headers PostgREST would set (`headers`). */
async function asWith<T>(who: Who, headers: Record<string, string> | null, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await become(db, who);
      if (headers) await db.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
      const out = await fn(db);
      await db.query("commit");
      return out;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}
const fromIp = (ip: string | null): Record<string, string> => (ip ? { "cf-connecting-ip": ip, "x-forwarded-for": `${ip}, 162.158.0.1` } : {});
type Answer = Record<string, unknown> & { event_id: string };
const clockFrom = (who: Who, ip: string | null, at: string | null = null, key = randomUUID()) =>
  asWith(who, fromIp(ip), async (db) => (await db.query<{ r: Answer }>("select public.record_attendance_event($1, 'in', $2, 'Phone') as r", [key, at])).rows[0].r);
/** The check row, with the address 078 keeps apart (attendance_event_network_ips, 30 days; the check row's own ip is always NULL). */
const check = (eventId: string) =>
  withDb(async (db) => (await db.query(
    `select n.status, host(coalesce(i.ip, n.ip)) as ip, n.off_site_network
       from public.attendance_event_networks n left join public.attendance_event_network_ips i on i.event_id = n.event_id
      where n.event_id = $1`, [eventId])).rows[0] ?? null);
const adminRpc = <R = Record<string, unknown>>(who: Who, text: string, params: unknown[], ip: string | null = null) =>
  asWith(who, fromIp(ip), async (db) => (await db.query<{ r: R }>(text, params)).rows[0].r);
async function adminRefusal(who: Who, text: string, params: unknown[], ip: string | null = null) {
  try {
    await adminRpc(who, text, params, ip);
    return null;
  } catch (err) {
    const e = err as { code?: string; hint?: string };
    return { code: e.code, hint: e.hint };
  }
}
const SET_CHECK = "select public.set_site_network_check($1, $2) as r";
const ADD = "select public.add_site_network($1, $2, $3) as r";
const REMOVE = "select public.remove_site_network($1, $2) as r";
const MEMBER = "select public.set_member_on_site_only($1, $2, $3) as r";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const auditCount = (action: string, entity: string) =>
  withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where action = $1 and entity_id = $2", [action, entity])).rows[0].n as number);

describe("with the defaults nothing changes", () => {
  it("switch off (no settings row) and nobody on-site-only: no check row; the answer and the audit rows are 050's", async () => {
    const r = await clockFrom(A().workshop, "198.51.100.9");
    expect(Object.keys(r).sort()).toEqual(["action", "at", "device_at", "event_id", "received_at", "replayed", "source", "supersedes", "time_adjusted", "user_id"]);
    expect(r).toMatchObject({ action: "in", replayed: false, source: "clock" });
    expect(await check(r.event_id)).toBeNull();
    const audit = await withDb(async (db) => (await db.query("select entity_table, action from security_audit.audit_log where entity_id = $1 order by id", [r.event_id])).rows);
    expect(audit).toEqual([{ entity_table: "attendance_events", action: "INSERT" }]);
    expect(await withDb(async (db) => (await db.query("select count(*)::int as n from public.attendance_event_networks where organization_id = $1", [world.tenants.alpha.id])).rows[0].n)).toBe(0);
  });

  it("an on-site-only person while the switch is off: still nothing written", async () => {
    await adminRpc(A().admin, MEMBER, [randomUUID(), A().workshop.id, true]);
    const r = await clockFrom(A().workshop, "198.51.100.9");
    expect(await check(r.event_id)).toBeNull();
    await adminRpc(A().admin, MEMBER, [randomUUID(), A().workshop.id, false]);
  });
});

describe("admin only, keyed, audited", () => {
  it("office, workshop and viewer are refused; another company's person is not a member", async () => {
    for (const who of [A().office, A().workshop]) {
      expect(await adminRefusal(who, SET_CHECK, [randomUUID(), "flag"])).toMatchObject({ code: "42501", hint: "admin_only" });
      expect(await adminRefusal(who, ADD, [randomUUID(), "203.0.113.0/28", "Workshop"])).toMatchObject({ code: "42501", hint: "admin_only" });
      expect(await adminRefusal(who, MEMBER, [randomUUID(), A().workshop.id, true])).toMatchObject({ code: "42501", hint: "admin_only" });
      expect(await adminRefusal(who, "select public.my_request_network() as r", [])).toMatchObject({ code: "42501", hint: "admin_only" });
    }
    expect(await adminRefusal(A().viewer, ADD, [randomUUID(), "203.0.113.0/28", "Workshop"])).toMatchObject({ code: "42501", hint: "not_allowed" });
    expect(await adminRefusal(A().admin, MEMBER, [randomUUID(), B().workshop.id, true])).toMatchObject({ code: "P0002", hint: "not_member" });
  });

  it("the switch needs a network; bad, private and too-broad networks are refused; 'the network I'm on now' saves the request's IP", async () => {
    expect(await adminRefusal(A().admin, SET_CHECK, [randomUUID(), "flag"])).toMatchObject({ code: "22023", hint: "no_networks" });
    expect(await adminRefusal(A().admin, SET_CHECK, [randomUUID(), "refuse"])).toMatchObject({ code: "22023", hint: "bad_mode" });
    expect(await adminRefusal(A().admin, ADD, [randomUUID(), "workshop", null])).toMatchObject({ code: "22023", hint: "bad_network" });
    expect(await adminRefusal(A().admin, ADD, [randomUUID(), "192.168.1.1", null])).toMatchObject({ code: "22023", hint: "private_network" });
    expect(await adminRefusal(A().admin, ADD, [randomUUID(), "100.64.1.1", null])).toMatchObject({ code: "22023", hint: "private_network" });
    expect(await adminRefusal(A().admin, ADD, [randomUUID(), "8.0.0.0/8", null])).toMatchObject({ code: "22023", hint: "too_broad" });
    for (const special of ["198.18.0.1", "192.0.0.9", "64:ff9b::203.0.113.7", "2002:cb00:7107::/48"]) {
      expect(await adminRefusal(A().admin, ADD, [randomUUID(), special, null]), special).toMatchObject({ code: "22023", hint: "private_network" });
    }
    expect(await adminRefusal(A().admin, ADD, [randomUUID(), null, null], null)).toMatchObject({ code: "22023", hint: "ip_unknown" });
    expect(await adminRefusal(A().admin, ADD, [randomUUID(), null, null], "10.1.2.3")).toMatchObject({ code: "22023", hint: "private_network" });
    // Typed: the host bits are cleared.
    const key = randomUUID();
    const typed = await adminRpc(A().admin, ADD, [key, "203.0.113.9/28", "Workshop"]);
    expect(typed).toMatchObject({ network: "203.0.113.0/28", label: "Workshop", added: true, replayed: false });
    // The same key and request: the first answer. The same key for something else: refused.
    expect(await adminRpc(A().admin, ADD, [key, "203.0.113.9/28", "Workshop"])).toMatchObject({ id: typed.id, replayed: true });
    expect(await adminRefusal(A().admin, ADD, [key, "203.0.113.64/28", "Workshop"])).toMatchObject({ code: "22023", hint: "client_op_reused" });
    // The same network again under a new key: that row, not a second one.
    expect(await adminRpc(A().admin, ADD, [randomUUID(), "203.0.113.0/28", "Workshop"])).toMatchObject({ id: typed.id, added: false });
    // The network I'm on now: IPv4 as /32, IPv6 as its /64.
    expect(await adminRpc(A().admin, ADD, [randomUUID(), null, "Marpet yard"], "198.51.100.77")).toMatchObject({ network: "198.51.100.77/32", label: "Marpet yard", added: true });
    expect(await adminRpc(A().admin, ADD, [randomUUID(), "", null], "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toMatchObject({ network: "2001:db8:1:2::/64", label: "Site network", added: true });
    expect(await auditCount("SITE_NETWORK_ADDED", String(typed.id))).toBe(1);
    const mine = await adminRpc(A().admin, "select public.my_request_network() as r", [], "2001:db8:1:2::99");
    expect(mine).toMatchObject({ ip: "2001:db8:1:2::99", network: "2001:db8:1:2::/64", on_saved_network: true, private: false, header: "cf-connecting-ip" });
    expect(await adminRpc(A().admin, "select public.my_request_network() as r", [], "192.0.2.1")).toMatchObject({ ip: "192.0.2.1", network: "192.0.2.1/32", on_saved_network: false });
    expect(await adminRpc(A().admin, "select public.my_request_network() as r", [], null)).toMatchObject({ ip: null, network: null, on_saved_network: false });
    // Switch on; audited before and after; a replay answers the first result.
    const on = randomUUID();
    expect(await adminRpc(A().admin, SET_CHECK, [on, "flag"])).toMatchObject({ mode: "flag", changed: true, replayed: false });
    expect(await adminRpc(A().admin, SET_CHECK, [on, "flag"])).toMatchObject({ mode: "flag", changed: true, replayed: true });
    expect(await adminRpc(A().admin, SET_CHECK, [randomUUID(), "flag"])).toMatchObject({ changed: false });
    const audit = await withDb(async (db) => (await db.query("select metadata ->> 'before' as before, metadata ->> 'after' as after from security_audit.audit_log where action = 'SITE_NETWORK_CHECK_SET' and organization_id = $1", [world.tenants.alpha.id])).rows);
    expect(audit).toEqual([{ before: "off", after: "flag" }]);
  });

  it("the person flag: on and off, audited, replayed; reads scoped by role and company", async () => {
    const key = randomUUID();
    expect(await adminRpc(A().admin, MEMBER, [key, A().workshop.id, true])).toMatchObject({ on_site_only: true, changed: true, replayed: false });
    expect(await adminRpc(A().admin, MEMBER, [key, A().workshop.id, true])).toMatchObject({ replayed: true });
    expect(await adminRefusal(A().admin, MEMBER, [key, A().workshop.id, false])).toMatchObject({ hint: "client_op_reused" });
    const events = await withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where action = 'MEMBER_ON_SITE_ONLY_SET' and entity_id = $1 order by created_at", [A().workshop.id])).rows.map((r) => r.metadata));
    expect(events.at(-1)).toMatchObject({ before: false, after: true });
    // Reads: admin and office everyone's flag and the networks; workshop its own flag only, no networks; viewer and beta nothing.
    const flags = (who: Who) => q<{ user_id: string }>(who, "select user_id from public.site_network_members where on_site_only").then((r) => r.map((x) => x.user_id));
    const nets = (who: Who) => q(who, "select id from public.site_networks").then((r) => r.length);
    expect(await flags(A().admin)).toEqual([A().workshop.id]);
    expect(await flags(A().office)).toEqual([A().workshop.id]);
    expect(await flags(A().workshop)).toEqual([A().workshop.id]);
    expect(await flags(A().viewer)).toEqual([]);
    expect(await flags(B().admin)).toEqual([]);
    expect(await nets(A().admin)).toBe(3);
    expect(await nets(A().office)).toBe(3);
    expect(await nets(A().workshop)).toBe(0);
    expect(await nets(A().viewer)).toBe(0);
    expect(await nets(B().admin)).toBe(0);
    // No direct writes.
    expect(await refusal(A().admin, "insert into public.site_networks (organization_id, network, label) values ($1, '192.0.2.0/24', 'x')", [world.tenants.alpha.id])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "update public.site_network_members set on_site_only = false")).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "insert into public.site_network_settings (organization_id) values ($1)", [world.tenants.alpha.id])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "select * from public.site_network_ops")).toMatchObject({ code: "42501" });
  });
});

describe("switch 'flag', on-site-only person: record and flag, never refuse", () => {
  it("inside a saved network: on site; outside: off site and flagged but recorded; no header: unknown; x-forwarded-for ignored", async () => {
    const on = await clockFrom(A().workshop, "203.0.113.5");
    expect(await check(on.event_id)).toEqual({ status: "on_site", ip: "203.0.113.5", off_site_network: false });
    const off = await clockFrom(A().workshop, "198.51.100.9");
    expect(off).toMatchObject({ action: "in", replayed: false });
    expect(await check(off.event_id)).toEqual({ status: "off_site", ip: "198.51.100.9", off_site_network: true });
    const none = await clockFrom(A().workshop, null);
    expect(await check(none.event_id)).toEqual({ status: "unknown", ip: null, off_site_network: false });
    // Only x-forwarded-for (spoofable first hop) naming a site address: not trusted, unknown.
    const xff = await asWith(A().workshop, { "x-forwarded-for": "203.0.113.5" }, async (db) => (await db.query<{ r: Answer }>("select public.record_attendance_event($1, 'out', null, null) as r", [randomUUID()])).rows[0].r);
    expect(await check(xff.event_id)).toMatchObject({ status: "unknown" });
  });

  it("IPv6 inside the saved /64 and an IPv4-mapped address match; a neighbouring /64 does not", async () => {
    expect(await check((await clockFrom(A().workshop, "2001:db8:1:2:1234::1")).event_id)).toMatchObject({ status: "on_site", off_site_network: false });
    expect(await check((await clockFrom(A().workshop, "2001:db8:1:3::1")).event_id)).toMatchObject({ status: "off_site", off_site_network: true });
    expect(await check((await clockFrom(A().workshop, "::ffff:203.0.113.6")).event_id)).toMatchObject({ status: "on_site", ip: "203.0.113.6" });
    expect(await check((await clockFrom(A().workshop, "198.51.100.77")).event_id)).toMatchObject({ status: "on_site" });
  });

  it("queued offline and synced later: 'synced_later', no IP, not flagged; a live action a few seconds old is checked", async () => {
    const late = await clockFrom(A().workshop, "198.51.100.9", minutesAgo(45));
    expect(await check(late.event_id)).toEqual({ status: "synced_later", ip: null, off_site_network: false });
    const live = await clockFrom(A().workshop, "198.51.100.9", new Date(Date.now() - 5_000).toISOString());
    expect(await check(live.event_id)).toMatchObject({ status: "off_site" });
  });

  it("a person who may work off site, and corrections, are never checked; a replay writes no second row", async () => {
    expect(await check((await clockFrom(A().office, "198.51.100.9")).event_id)).toBeNull();
    const key = randomUUID();
    const first = await clockFrom(A().workshop, "198.51.100.9", null, key);
    const again = await clockFrom(A().workshop, "203.0.113.5", null, key);
    expect(again).toMatchObject({ event_id: first.event_id, replayed: true });
    expect(await check(first.event_id)).toMatchObject({ status: "off_site" });
    const fixed = await asWith(A().workshop, fromIp("198.51.100.9"), async (db) =>
      (await db.query<{ r: Answer }>("select public.correct_attendance_event($1, null, null, 'out', $2, 'forgot to clock out') as r", [randomUUID(), minutesAgo(30)])).rows[0].r);
    expect(await check(fixed.event_id)).toBeNull();
  });

  it("an error inside the check never refuses the clock action (recorded, no check row)", async () => {
    const id = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("create or replace function public.site_network_matches(p_org uuid, p_ip inet) returns boolean language plpgsql stable set search_path = pg_catalog, public as $$ begin raise exception 'broken check'; end $$");
        await become(db, A().workshop);
        await db.query("select set_config('request.headers', $1, true)", [JSON.stringify(fromIp("203.0.113.5"))]);
        const r = (await db.query<{ r: Answer }>("select public.record_attendance_event($1, 'in', null, null) as r", [randomUUID()])).rows[0].r;
        const rows = (await db.query("select count(*)::int as n from public.attendance_events where id = $1", [r.event_id])).rows[0].n;
        await db.query("reset role");
        const checks = (await db.query("select count(*)::int as n from public.attendance_event_networks where event_id = $1", [r.event_id])).rows[0].n;
        return { rows, checks };
      } finally {
        await db.query("rollback");
      }
    });
    expect(id).toEqual({ rows: 1, checks: 0 });
  });

  it("reads: admin and office see every check row; workshop only its own; viewer and the other company none; check rows never change", async () => {
    // The office person's clock actions are not checked; the admin's own (made on-site-only now) are.
    await adminRpc(A().admin, MEMBER, [randomUUID(), A().admin.id, true]);
    const adminOff = await clockFrom(A().admin, "198.51.100.10");
    const count = (who: Who) => q<{ n: number }>(who, "select count(*)::int as n, count(*) filter (where user_id <> auth.uid())::int as others from public.attendance_event_networks").then((r) => r[0] as unknown as { n: number; others: number });
    const all = await withDb(async (db) => (await db.query("select count(*)::int as n from public.attendance_event_networks where organization_id = $1", [world.tenants.alpha.id])).rows[0].n);
    expect((await count(A().admin)).n).toBe(all);
    expect((await count(A().office)).n).toBe(all);
    const ws = await count(A().workshop);
    expect(ws.n).toBe(all - 1);
    expect(ws).toMatchObject({ others: 0 });
    expect((await count(A().viewer)).n).toBe(0);
    expect((await count(B().admin)).n).toBe(0);
    expect(await check(adminOff.event_id)).toMatchObject({ status: "off_site", off_site_network: true });
    const err = await withDb(async (db) => db.query("update public.attendance_event_networks set off_site_network = false, status = 'on_site' where event_id = $1", [adminOff.event_id]).then(() => null, (e) => e.code));
    expect(err).toBe("42501");
  });

  it("the last network can't be removed while the check is on; switching off stops all checking", async () => {
    const ids = (await withDb(async (db) => (await db.query("select id from public.site_networks where organization_id = $1 order by created_at", [world.tenants.alpha.id])).rows)).map((r) => r.id as string);
    for (const id of ids.slice(1)) expect(await adminRpc(A().admin, REMOVE, [randomUUID(), id])).toMatchObject({ removed: true });
    expect(await adminRefusal(A().admin, REMOVE, [randomUUID(), ids[0]])).toMatchObject({ code: "22023", hint: "last_network" });
    expect(await adminRefusal(A().admin, REMOVE, [randomUUID(), ids[1]])).toMatchObject({ code: "P0002", hint: "network_missing" });
    expect(await auditCount("SITE_NETWORK_REMOVED", ids[1])).toBe(1);
    expect(await adminRpc(A().admin, SET_CHECK, [randomUUID(), "off"])).toMatchObject({ mode: "off", changed: true });
    expect(await check((await clockFrom(A().workshop, "198.51.100.9")).event_id)).toBeNull();
    expect(await adminRpc(A().admin, REMOVE, [randomUUID(), ids[0]])).toMatchObject({ removed: true });
  });
});
