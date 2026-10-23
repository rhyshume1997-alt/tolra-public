/**
 * Clock-in addresses after migration 078 (B40 / G21, Rhys's decision: kept 30 days, never in the audit log, never trusted on their own):
 *
 *   * the check row (attendance_event_networks) keeps status, off_site_network and the check time, never the address (ip always NULL);
 *     the address of an on_site / off_site check is in attendance_event_network_ips, which is not audited: with request.headers set, no
 *     audit row written by a clock action (new_data, old_data, metadata, ip_address: the whole row) holds the address;
 *   * addresses older than 30 days are deleted by the company's next clock action (that company only), recent ones kept; the check rows
 *     stay; a purge never waits for rows another transaction holds; an admin can delete the expired ones, or all, at once (audited: the
 *     count only);
 *   * purges during concurrent clock-ins (two companies, an admin purge in between): no error, no deadlock, every clock action checked;
 *   * reads: admin and office the company's addresses, workshop only their own, viewer and the other company none; no direct writes;
 *   * a seen address never becomes a site network by itself: only add_site_network (an admin) writes site_networks.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

import { type Who, become, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;
const ORG = () => world.tenants.alpha.id;

/** Runs `fn` as `who` in one committed transaction, with the request headers PostgREST would set. */
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
const clockFrom = (who: Who, ip: string | null, action = "in", at: string | null = null) =>
  asWith(who, fromIp(ip), async (db) => (await db.query<{ r: Answer }>("select public.record_attendance_event($1, $2, $3, 'Phone') as r", [randomUUID(), action, at])).rows[0].r);
const rpc = <R = Record<string, unknown>>(who: Who, text: string, params: unknown[] = [], ip: string | null = null) =>
  asWith(who, fromIp(ip), async (db) => (await db.query<{ r: R }>(text, params)).rows[0].r);
const sql = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows);
/** The check row and the kept address of one clock action. */
const check = async (eventId: string) => (await sql<{ status: string; flag: boolean; row_ip: string | null; ip: string | null }>(
  `select n.status, n.off_site_network as flag, host(n.ip) as row_ip, host(i.ip) as ip
     from public.attendance_event_networks n left join public.attendance_event_network_ips i on i.event_id = n.event_id
    where n.event_id = $1`, [eventId]))[0] ?? null;
const PURGE = "select public.purge_site_network_ips($1) as r";
/** Backdates kept addresses (the table is mutable; only the owner can do this). */
const age = (eventIds: string[], days: number) =>
  sql("update public.attendance_event_network_ips set checked_at = now() - make_interval(days => $2) where event_id = any($1::uuid[])", [eventIds, days]);
const kept = async (eventIds: string[]) => (await sql<{ event_id: string }>("select event_id from public.attendance_event_network_ips where event_id = any($1::uuid[]) order by event_id", [eventIds])).map((r) => r.event_id);

async function switchOn(admin: Who, person: Who, network: string) {
  await rpc(admin, "select public.add_site_network($1, $2, 'Workshop') as r", [randomUUID(), network]);
  await rpc(admin, "select public.set_site_network_check($1, 'flag') as r", [randomUUID()]);
  await rpc(admin, "select public.set_member_on_site_only($1, $2, true) as r", [randomUUID(), person.id]);
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  await switchOn(A().admin, A().workshop, "203.0.113.0/28");
  await rpc(A().admin, "select public.set_member_on_site_only($1, $2, true) as r", [randomUUID(), A().admin.id]);
  await switchOn(B().admin, B().workshop, "192.0.2.0/28");
});
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

describe("the address is kept apart and never reaches the audit log", () => {
  it("retention is 30 days", async () => {
    expect((await sql<{ d: string }>("select public.site_network_ip_retention()::text as d"))[0].d).toBe("30 days");
  });

  it("on site and off site: the check row has no address, the kept row has it; unknown and synced later keep none", async () => {
    const on = await clockFrom(A().workshop, "203.0.113.5");
    expect(await check(on.event_id)).toEqual({ status: "on_site", flag: false, row_ip: null, ip: "203.0.113.5" });
    const off = await clockFrom(A().workshop, "198.51.100.9", "out");
    expect(await check(off.event_id)).toEqual({ status: "off_site", flag: true, row_ip: null, ip: "198.51.100.9" });
    const none = await clockFrom(A().workshop, null);
    expect(await check(none.event_id)).toEqual({ status: "unknown", flag: false, row_ip: null, ip: null });
    const late = await clockFrom(A().workshop, "198.51.100.9", "out", new Date(Date.now() - 45 * 60_000).toISOString());
    expect(await check(late.event_id)).toEqual({ status: "synced_later", flag: false, row_ip: null, ip: null });
    // The kept row is the check's: same company, person and check time.
    expect((await sql("select count(*)::int as n from public.attendance_event_network_ips i join public.attendance_event_networks n on n.event_id = i.event_id where i.event_id = any($1::uuid[]) and i.organization_id = n.organization_id and i.user_id = n.user_id and i.checked_at = n.checked_at", [[on.event_id, off.event_id]]))[0].n).toBe(2);
    // No direct way to put an address back on a check row.
    const err = await sql("update public.attendance_event_networks set ip = '198.51.100.9' where event_id = $1", [off.event_id]).then(() => null, (e) => e.code);
    expect(err).toBe("42501");
  });

  it("with request.headers set, no audit row written by on_site / off_site clock actions holds the address, anywhere in the row", async () => {
    const since = (await sql<{ t: string }>("select clock_timestamp()::text as t"))[0].t;
    const ips = ["203.0.113.9", "198.51.100.23", "2001:db8:77::5"];
    const events: string[] = [];
    for (const ip of ips) events.push((await clockFrom(A().workshop, ip)).event_id);
    events.push((await clockFrom(A().admin, "198.51.100.24")).event_id);
    expect((await Promise.all(events.map(check))).map((c) => c?.status)).toEqual(["on_site", "off_site", "off_site", "off_site"]);
    const rows = await sql<{ entity_table: string; action: string; old_ip: unknown; new_ip: unknown; row: string }>(
      `select a.entity_table, a.action, a.old_data -> 'ip' as old_ip, a.new_data -> 'ip' as new_ip, row_to_json(a)::text as row
         from security_audit.audit_log a where a.organization_id = $1 and a.created_at >= $2::timestamptz`, [ORG(), since]);
    // The clock rows and the check rows were audited (so the test looks at real rows) ...
    expect(rows.filter((r) => r.entity_table === "attendance_event_networks" && r.action === "INSERT")).toHaveLength(4);
    expect(rows.filter((r) => r.entity_table === "attendance_events")).toHaveLength(4);
    // ... the check rows' copies have ip null, nothing of the kept-address table is audited, and no row mentions an address.
    for (const r of rows.filter((x) => x.entity_table === "attendance_event_networks")) {
      expect(r.new_ip).toBeNull();
      expect(r.old_ip ?? null).toBeNull();
    }
    expect(rows.some((r) => r.entity_table === "attendance_event_network_ips")).toBe(false);
    for (const ip of [...ips, "198.51.100.24", "2001:db8:77:0:0:0:0:5"]) expect(rows.filter((r) => r.row.includes(ip)), ip).toEqual([]);
    // And in the whole log, no row for this company's checks has ever held an address.
    expect((await sql("select count(*)::int as n from security_audit.audit_log where organization_id = $1 and entity_table in ('attendance_event_networks', 'attendance_event_network_ips') and (new_data ->> 'ip' is not null or old_data ->> 'ip' is not null)", [ORG()]))[0].n).toBe(0);
  });
});

/**
 * Breaks the address table with `breakIt` (as the owner, inside one transaction that is rolled back), then clocks as the on-site-only
 * fitter from an off-site address: what was recorded.
 */
async function clockWithBrokenAddressTable(breakIt: string) {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      // An expired address, so the purge probe runs its query (and fails, when the table is broken).
      const old = (await db.query<{ id: string }>("select event_id as id from public.attendance_event_network_ips where organization_id = $1 limit 1", [ORG()])).rows[0]?.id;
      if (old) await db.query("update public.attendance_event_network_ips set checked_at = now() - interval '40 days' where event_id = $1", [old]);
      await db.query(breakIt);
      await become(db, A().workshop);
      await db.query("select set_config('request.headers', $1, true)", [JSON.stringify(fromIp("198.51.100.144"))]);
      const r = (await db.query<{ r: Answer }>("select public.record_attendance_event($1, 'in', null, 'Phone') as r", [randomUUID()])).rows[0].r;
      await db.query("reset role");
      const events = (await db.query("select count(*)::int as n from public.attendance_events where id = $1", [r.event_id])).rows[0].n;
      const row = (await db.query("select status, off_site_network as flag from public.attendance_event_networks where event_id = $1", [r.event_id])).rows[0] ?? null;
      return { events, row };
    } finally {
      await db.query("rollback");
    }
  });
}

describe("never refuses a clock action, whatever breaks", () => {
  it("the expiry probe failing (checked_at renamed): the clock action is recorded, with its check row and flag", async () => {
    const got = await clockWithBrokenAddressTable("alter table public.attendance_event_network_ips rename column checked_at to checked_at_broken");
    expect(got).toEqual({ events: 1, row: { status: "off_site", flag: true } });
  });

  it("only the address insert failing: the check row and its flag survive, without the address", async () => {
    const got = await clockWithBrokenAddressTable("alter table public.attendance_event_network_ips add constraint broken_for_test check (false) not valid");
    expect(got).toEqual({ events: 1, row: { status: "off_site", flag: true } });
  });

  it("the address table gone altogether: still recorded, with its check row", async () => {
    const got = await clockWithBrokenAddressTable("alter table public.attendance_event_network_ips rename to attendance_event_network_ips_gone");
    expect(got).toEqual({ events: 1, row: { status: "off_site", flag: true } });
  });
});

describe("30 days, then deleted", () => {
  it("the company's next clock action deletes its expired addresses, keeps recent ones and every check row; the other company's stay", async () => {
    const a = [await clockFrom(A().workshop, "198.51.100.31"), await clockFrom(A().workshop, "198.51.100.32"), await clockFrom(A().workshop, "198.51.100.33")].map((r) => r.event_id);
    const b = [(await clockFrom(B().workshop, "198.51.100.41")).event_id];
    await age([a[0], b[0]], 31);
    await age([a[1]], 29);
    // A clock action of someone who is not checked (office): still runs the company's purge.
    const office = await clockFrom(A().office, "198.51.100.50");
    expect(await check(office.event_id)).toBeNull();
    expect(await kept([...a, ...b])).toEqual([...a.slice(1), b[0]].sort());
    expect((await sql("select count(*)::int as n from public.attendance_event_networks where event_id = any($1::uuid[])", [[...a, ...b]]))[0].n).toBe(4);
    expect(await check(a[0])).toEqual({ status: "off_site", flag: true, row_ip: null, ip: null });
    // Beta's own next clock action deletes beta's.
    await clockFrom(B().office, null);
    expect(await kept(b)).toEqual([]);
    // Nothing older than 30 days is left in either company.
    expect((await sql("select count(*)::int as n from public.attendance_event_network_ips where organization_id = any($1::uuid[]) and checked_at < now() - interval '30 days'", [[ORG(), world.tenants.beta.id]]))[0].n).toBe(0);
  });

  it("a purge never waits: rows another transaction holds are skipped, and the clock action is recorded at once", async () => {
    const e = (await clockFrom(A().workshop, "198.51.100.61")).event_id;
    await age([e], 40);
    const holder = await withDb(async (db) => {
      await db.query("begin");
      await db.query("select 1 from public.attendance_event_network_ips where event_id = $1 for update", [e]);
      const started = Date.now();
      await db.query("set lock_timeout = '5s'");
      const r = await clockFrom(A().office, null);
      const ms = Date.now() - started;
      await db.query("rollback");
      return { ms, recorded: Boolean(r.event_id) };
    });
    expect(holder.recorded).toBe(true);
    expect(holder.ms).toBeLessThan(4000);
    expect(await kept([e])).toEqual([e]); // skipped while held
    await clockFrom(A().office, null);
    expect(await kept([e])).toEqual([]); // deleted by the next one
  });

  it("the purge inside a clock action takes at most 500 rows, oldest first", async () => {
    const r = await sql<{ n: number }>("select public.site_network_ip_purge($1, 0) as n", [ORG()]);
    expect(r[0].n).toBe(0);
    const body = (await sql<{ src: string }>("select prosrc as src from pg_proc where oid = 'public.attendance_events_network()'::regprocedure"))[0].src;
    expect(body).toContain("site_network_ip_purge(NEW.organization_id, 500)");
  });

  it("an admin deletes the expired ones, or all of them (audited: the count, never an address); others are refused", async () => {
    const e = [await clockFrom(A().workshop, "198.51.100.71"), await clockFrom(A().workshop, "198.51.100.72")].map((r) => r.event_id);
    const b = (await clockFrom(B().workshop, "198.51.100.73")).event_id;
    await age([e[0]], 31);
    for (const who of [A().office, A().workshop]) expect(await refusal(who, PURGE, [false])).toMatchObject({ code: "42501", hint: "admin_only" });
    expect(await refusal(A().viewer, PURGE, [false])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, PURGE, [null])).toMatchObject({ code: "22023", hint: "bad_flag" });
    expect(await rpc(A().admin, PURGE, [false])).toEqual({ removed: 1, all: false, retention_days: 30 });
    expect(await kept(e)).toEqual([e[1]]);
    expect(await rpc(A().admin, PURGE, [false])).toEqual({ removed: 0, all: false, retention_days: 30 });
    const all = await rpc<{ removed: number }>(A().admin, PURGE, [true]);
    expect(all.removed).toBeGreaterThanOrEqual(1);
    expect((await sql("select count(*)::int as n from public.attendance_event_network_ips where organization_id = $1", [ORG()]))[0].n).toBe(0);
    expect(await kept([b])).toEqual([b]); // the other company's stay
    const events = await sql<{ metadata: Record<string, unknown>; row: string }>("select metadata, row_to_json(a)::text as row from security_audit.audit_log a where organization_id = $1 and action = 'SITE_NETWORK_IPS_PURGED' order by created_at", [ORG()]);
    expect(events.map((x) => [x.metadata.removed, x.metadata.all])).toEqual([[1, false], [all.removed, true]]);
    for (const x of events) expect(x.row).not.toMatch(/198\.51\.100|203\.0\.113/);
    // The check rows are all still there.
    expect((await sql("select count(*)::int as n from public.attendance_event_networks where event_id = any($1::uuid[])", [e]))[0].n).toBe(2);
  });
});

describe("purges during concurrent clock-ins", () => {
  it("two companies clocking at once, expired rows to delete and admin purges in between: no error, every clock action checked", async () => {
    // Expired rows in both companies.
    const old = [];
    for (let i = 0; i < 6; i++) old.push((await clockFrom(i % 2 ? B().workshop : A().workshop, `198.51.100.${100 + i}`)).event_id);
    await age(old, 35);
    const jobs: Promise<unknown>[] = [];
    const recorded: { who: string; event_id: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const who = [A().workshop, A().admin, B().workshop, A().office][i % 4];
      jobs.push(clockFrom(who, `198.51.100.${150 + (i % 50)}`, i % 8 < 4 ? "in" : "out").then((r) => recorded.push({ who: who.id, event_id: r.event_id })));
      if (i % 10 === 5) jobs.push(rpc(A().admin, PURGE, [false]));
    }
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(recorded).toHaveLength(40);
    // Every clock action of an on-site-only person has its check row and its address; the office person's none.
    const checked = recorded.filter((r) => r.who !== A().office.id);
    const rows = await sql<{ n: number; ips: number }>("select count(n.*)::int as n, count(i.*)::int as ips from unnest($1::uuid[]) e(id) left join public.attendance_event_networks n on n.event_id = e.id left join public.attendance_event_network_ips i on i.event_id = e.id", [checked.map((r) => r.event_id)]);
    expect(rows[0]).toEqual({ n: checked.length, ips: checked.length });
    expect(await kept(old)).toEqual([]);
    expect((await sql("select count(*)::int as n from public.attendance_event_network_ips where organization_id = any($1::uuid[]) and checked_at < now() - interval '30 days'", [[ORG(), world.tenants.beta.id]]))[0].n).toBe(0);
  });
});

describe("who can read the addresses", () => {
  it("admin and office the company's; workshop only their own; viewer and the other company none; no direct writes", async () => {
    await clockFrom(A().workshop, "198.51.100.201");
    await clockFrom(A().admin, "198.51.100.202");
    const count = (who: Who) => q<{ n: number; others: number }>(who, "select count(*)::int as n, count(*) filter (where user_id <> auth.uid())::int as others from public.attendance_event_network_ips").then((r) => r[0]);
    const all = (await sql<{ n: number }>("select count(*)::int as n from public.attendance_event_network_ips where organization_id = $1", [ORG()]))[0].n;
    expect(all).toBeGreaterThanOrEqual(2);
    expect((await count(A().admin)).n).toBe(all);
    expect((await count(A().office)).n).toBe(all);
    const ws = await count(A().workshop);
    expect(ws.others).toBe(0);
    expect(ws.n).toBeGreaterThanOrEqual(1);
    expect(ws.n).toBeLessThan(all);
    expect((await count(A().viewer)).n).toBe(0);
    expect((await q<{ n: number }>(B().admin, "select count(*)::int as n from public.attendance_event_network_ips where organization_id = $1", [ORG()]))[0].n).toBe(0);
    for (const text of ["delete from public.attendance_event_network_ips", "update public.attendance_event_network_ips set ip = '192.0.2.1'",
      "insert into public.attendance_event_network_ips (event_id, organization_id, user_id, ip, checked_at) select event_id, organization_id, user_id, '192.0.2.1', now() from public.attendance_event_networks limit 1"]) {
      expect(await refusal(A().admin, text), text).toMatchObject({ code: "42501" });
    }
  });
});

describe("a seen address is never trusted by itself", () => {
  it("only add_site_network writes site_networks; no trigger on it does; clock actions from new addresses add none", async () => {
    // Every function whose body inserts into or updates site_networks: add_site_network only (remove_site_network deletes).
    const writers = await sql<{ f: string }>(`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'security_audit') and p.prosrc ~* '(insert\\s+into|update)\\s+(public\\.)?site_networks\\M' order by 1`);
    expect(writers.map((w) => w.f)).toEqual(["add_site_network(uuid,text,text)"]);
    expect((await sql<{ admin_only: boolean }>("select prosrc like '%site_network_admin_org()%' as admin_only from pg_proc where oid = 'public.add_site_network(uuid,text,text)'::regprocedure"))[0].admin_only).toBe(true);
    // Triggers that write elsewhere don't target it: the only triggers on site_networks are the guards and the audit copy.
    const triggers = await sql<{ t: string }>("select tgname as t from pg_trigger where tgrelid = 'public.site_networks'::regclass and not tgisinternal order by 1");
    expect(triggers.map((t) => t.t)).toEqual(["admin_mfa", "audit_site_networks_changes", "support_read_only"]);
    // Many clock actions from a new address change nothing.
    const before = (await sql<{ n: number }>("select count(*)::int as n from public.site_networks where organization_id = $1", [ORG()]))[0].n;
    for (let i = 0; i < 5; i++) await clockFrom(A().workshop, "198.51.100.250");
    expect((await sql<{ n: number }>("select count(*)::int as n from public.site_networks where organization_id = $1", [ORG()]))[0].n).toBe(before);
    // No API role writes it directly.
    expect(await refusal(A().admin, "insert into public.site_networks (organization_id, network, label) values ($1, '198.51.100.250/32', 'x')", [ORG()])).toMatchObject({ code: "42501" });
  });
});
