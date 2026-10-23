/**
 * Internal jobs, a new job from the Job Board and the machines a job runs on (migration 042), through the real API path: Supabase
 * Auth + PostgREST with signed-in synthetic users, so the database's own rules are under test.
 *
 *   * create_job: admin, office and workshop create; the viewer and anon can't; a customer job needs a customer, an internal one doesn't;
 *     the J number comes from the same sequence as convert_sales_order, also when both run at the same moment;
 *   * machines: one booking per machine from its own start, a job_machines row each, read by the whole company, written by the
 *     function only; another company's machine or related job is refused, and a refusal leaves nothing behind;
 *   * clashes: found by the function from machine_bookings (the app's list is only a hint), refused for everyone but an admin who books
 *     anyway, which is audited with the job numbers found; complete bookings and free slots don't clash; a day-split booking counts as one span;
 *   * the table job_machines takes no insert, update or delete from any role; an admin at aal1 is refused when the company requires MFA;
 *   * dates: the date required and every start must fall in 2000..2100; the app's clash hint is capped at 20000 characters;
 *   * two jobs asked for the same machine and time at the same moment: one is made, the other refused (the per-company lock serialises
 *     the clash check with the number and the inserts).
 *   * is_internal never changes; the related job is in the same company and never the job itself;
 *   * the read-only verify script is clean.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, setRequireAdminMfaForTest, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let mill: string;
let lathe: string;
let retired: string;
let betaMachine: string;
let betaJob: string;

const START = "2026-11-02T08:00:00Z";
type Args = { p_customer?: string | null; p_description?: string; p_internal?: boolean; p_related?: string | null; p_required?: string | null; p_machines?: unknown; p_clash_override?: boolean; p_clashes?: unknown; p_override_reason?: string | null };
const args = (over: Args = {}) => ({ p_customer: "Acme Ltd", p_description: "Brackets", p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null, ...over });
const create = (client: SupabaseClient, over: Args = {}) => client.rpc("create_job", args(over));
const num = (jobNo: string) => Number(jobNo.replace(/^J-/, ""));

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  const service = adminClient();
  const machine = async (org: string, name: string, active = true) => (await service.from("machines").insert({ organization_id: org, name, active }).select("id").single()).data!.id as string;
  mill = await machine(world.tenants.alpha.id, `Mill ${world.runId}`);
  lathe = await machine(world.tenants.alpha.id, `Lathe ${world.runId}`);
  retired = await machine(world.tenants.alpha.id, `Old saw ${world.runId}`, false);
  betaMachine = await machine(world.tenants.beta.id, `Beta Mill ${world.runId}`);
  betaJob = (await service.from("jobs").insert({ organization_id: world.tenants.beta.id, job_no: `J-B-${world.runId}`, customer: "Beta customer" }).select("id").single()).data!.id;
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("who can create a job", () => {
  it.each(["admin", "office", "workshop"])("%s creates a customer job with no sales order and no PO", async (role) => {
    const { data, error } = await create(as[role], { p_customer: `Acme ${role}`, p_required: "2026-12-01" });
    expect(error).toBeNull();
    expect(data.job_no).toMatch(/^J-\d{4,}$/);
    const { data: row } = await adminClient().from("jobs").select("*").eq("id", data.job_id).single();
    expect(row).toMatchObject({ organization_id: world.tenants.alpha.id, job_no: data.job_no, customer: `Acme ${role}`, is_internal: false, related_job_id: null, customer_po: null, stage: "material", converted_from_sales_order_id: null, date_required: "2026-12-01" });
  });

  it("the viewer, anon and another company's session can't", async () => {
    expect((await create(as.viewer)).error?.code).toBe("42501");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await create(anon)).error).not.toBeNull();
    // beta's admin creates in beta only: alpha's machine is not found for them.
    expect((await create(as.betaAdmin, { p_machines: [{ machine_id: mill, hours: 2, start_at: START }] })).error?.code).toBe("P0002");
  });

  it("a customer job needs a customer; an internal job doesn't, and is tagged internal", async () => {
    expect((await create(as.office, { p_customer: "  " })).error?.code).toBe("22023");
    expect((await create(as.office, { p_customer: null })).error?.code).toBe("22023");
    expect((await create(as.office, { p_description: "" })).error?.code).toBe("22023");
    const { data, error } = await create(as.workshop, { p_customer: null, p_internal: true, p_description: "Soft jaws for the lathe" });
    expect(error).toBeNull();
    const { data: row } = await adminClient().from("jobs").select("customer, is_internal, customer_po").eq("id", data.job_id).single();
    expect(row).toEqual({ customer: null, is_internal: true, customer_po: null });
  });
});

describe("job numbers", () => {
  it("come from the same J sequence as converted orders, without gaps or repeats when both run at once, in both companies, over several rounds", async () => {
    const service = adminClient();
    for (const [tenant, convertAs, createAs] of [["alpha", as.office, as.workshop], ["beta", as.betaAdmin, as.betaAdmin]] as const) {
      const org = world.tenants[tenant].id;
      for (let round = 0; round < 3; round += 1) {
        const counter = async () => Number((await service.from("doc_counters").select("last").eq("organization_id", org).eq("prefix", "J").maybeSingle()).data?.last ?? 0);
        const before = await counter();
        const orders: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          orders.push((await service.from("sales_orders").insert({ organization_id: org, so_number: `SO-IJ-${world.runId}-${tenant}-${round}-${i}`, customer: "Acme Ltd", total_value: 10, status: "open" }).select("id").single()).data!.id);
        }
        const results = await Promise.all([
          ...orders.map((id) => convertAs.rpc("convert_sales_order", { p_order: id })),
          ...[0, 1, 2].map((i) => create(createAs, { p_internal: i % 2 === 0, p_customer: i % 2 ? "Acme Ltd" : null, p_description: `Race ${tenant} ${round} ${i}` })),
        ]);
        for (const r of results) expect(r.error, `${tenant} round ${round}`).toBeNull();
        const numbers = results.map((r) => num(r.data.job_no)).sort((a, b) => a - b);
        expect(new Set(numbers).size).toBe(6);
        expect(numbers[0]).toBe(before + 1);
        expect(numbers[5]).toBe(before + 6);
        expect(await counter()).toBe(before + 6);
        const made = await service.from("jobs").select("job_no, is_internal, converted_from_sales_order_id").eq("organization_id", org).in("job_no", results.map((r) => r.data.job_no));
        expect(made.data).toHaveLength(6);
        expect(made.data!.filter((j) => j.converted_from_sales_order_id)).toHaveLength(3);
        for (const r of results) expect(r.data.job_no).toMatch(/^J-\d{4,}$/);
      }
    }
  });
});

describe("the J-number lock on direct connections", () => {
  // Not through PostgREST's pool (whose size could serialise calls by itself): two postgres connections, each as the signed-in person's
  // session. The first takes a number and holds its transaction open; the second is shown waiting on the per-company advisory lock
  // (pg_locks), not failing and not done; when the first commits, the second gets the next number. Both companies.
  it("the second transaction waits on the per-company lock until the first commits; both get distinct, contiguous numbers", async () => {
    const service = adminClient();
    for (const [tenant, c] of [["alpha", as.office], ["beta", as.betaAdmin]] as const) {
      const org = world.tenants[tenant].id;
      const token = (await c.auth.getSession()).data.session!.access_token;
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string; session_id: string; aal?: string };
      const order = (await service.from("sales_orders").insert({ organization_id: org, so_number: `SO-LOCK-${world.runId}-${tenant}`, customer: "Lock Co", total_value: 10, status: "open" }).select("id").single()).data!.id;
      const open = async () => {
        const db = new Client({ connectionString: isolatedBackend().databaseUrl });
        await db.connect();
        await db.query("begin");
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, role: "authenticated", aud: "authenticated", session_id: claims.session_id, aal: claims.aal ?? "aal1" })]);
        return db;
      };
      const a = await open();
      const b = await open();
      try {
        const first = (await a.query<{ j: { job_no: string } }>("select public.create_job($1, $2, false, null, null, '[]'::jsonb, false, '[]'::jsonb, null) as j", ["Lock Co", `Lock ${tenant}`])).rows[0].j;
        let settled = false;
        const second = b.query<{ j: { job_no: string } }>("select public.convert_sales_order($1) as j", [order]).then((r) => { settled = true; return r.rows[0].j; }, (err) => { settled = true; throw err; });
        const waiting = await withDb(async (db) => {
          for (let i = 0; i < 200; i += 1) {
            const r = await db.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted");
            if (r.rows[0].n > 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return false;
        });
        expect(waiting, `${tenant}: the second connection waits on the advisory lock`).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled, `${tenant}: still waiting while the first holds its transaction`).toBe(false);
        await a.query("commit");
        const next = await second;
        await b.query("commit");
        expect(num(next.job_no)).toBe(num(first.job_no) + 1);
        expect((await service.from("jobs").select("job_no").eq("organization_id", org).in("job_no", [first.job_no, next.job_no])).data).toHaveLength(2);
      } finally {
        await a.end().catch(() => undefined);
        await b.end().catch(() => undefined);
      }
    }
  });
});

describe("machines and bookings", () => {
  it("books each machine from its own start, in parallel, and links them to the job", async () => {
    const { data, error } = await create(as.office, { p_machines: [{ machine_id: mill, hours: 6, start_at: START }, { machine_id: lathe, hours: 2.5, start_at: "2026-11-03T09:00:00Z" }] });
    expect(error).toBeNull();
    const { data: links } = await as.viewer.from("job_machines").select("machine_id, estimated_hours, booking_id, position").eq("job_id", data.job_id).order("position");
    expect(links!.map((l) => [l.machine_id, Number(l.estimated_hours), l.position])).toEqual([[mill, 6, 0], [lathe, 2.5, 1]]);
    const { data: bookings } = await as.viewer.from("machine_bookings").select("id, machine_id, job_id, job_no, start_at, estimated_hours, status").eq("job_id", data.job_id).order("start_at");
    expect(bookings!.map((b) => [b.machine_id, b.job_no, new Date(b.start_at).toISOString(), Number(b.estimated_hours), b.status])).toEqual([
      [mill, data.job_no, "2026-11-02T08:00:00.000Z", 6, "booked"], [lathe, data.job_no, "2026-11-03T09:00:00.000Z", 2.5, "booked"]]);
    expect(links!.map((l) => l.booking_id).sort()).toEqual(bookings!.map((b) => b.id).sort());
    // Read by the company only, written by the function only.
    expect((await as.betaAdmin.from("job_machines").select("id").eq("job_id", data.job_id)).data).toEqual([]);
    const direct = await as.admin.from("job_machines").insert({ organization_id: world.tenants.alpha.id, job_id: data.job_id, machine_id: retired, estimated_hours: 1 });
    expect(direct.error?.code).toBe("42501");
    expect((await as.admin.from("job_machines").delete().eq("job_id", data.job_id).select("id")).data ?? []).toEqual([]);
  });

  it("refuses another company's machine, an inactive machine, a duplicate, bad hours and more than 10 machines, and leaves nothing behind", async () => {
    const service = adminClient();
    const count = async () => (await service.from("jobs").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count;
    const before = await count();
    const counter = async () => (await service.from("doc_counters").select("last").eq("organization_id", world.tenants.alpha.id).eq("prefix", "J").single()).data!.last;
    const lastBefore = await counter();
    const bookings = async () => (await service.from("machine_bookings").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count;
    const links = async () => (await service.from("job_machines").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count;
    const bookingsBefore = await bookings();
    const linksBefore = await links();
    const good = { machine_id: mill, hours: 1, start_at: START };
    expect((await create(as.admin, { p_machines: [good, { machine_id: betaMachine, hours: 1, start_at: START }] })).error?.code).toBe("P0002");
    expect((await create(as.admin, { p_machines: [good, { machine_id: retired, hours: 1, start_at: START }] })).error?.code).toBe("P0002");
    expect((await create(as.admin, { p_machines: [good, good] })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_machines: [{ ...good, hours: 1001 }] })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_machines: [{ ...good, hours: -1 }] })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_machines: [{ ...good, start_at: "not a date" }] })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_machines: Array.from({ length: 11 }, () => good) })).error?.code).toBe("22023");
    expect(await count()).toBe(before);
    expect(await counter()).toBe(lastBefore);
    expect((await service.from("machine_bookings").select("id").eq("organization_id", world.tenants.beta.id).eq("machine_id", betaMachine)).data).toEqual([]);
    // The good row that came before the failing one left no booking and no job machine behind.
    expect(await bookings()).toBe(bookingsBefore);
    expect(await links()).toBe(linksBefore);
  });
});

describe("clashes", () => {
  // Found by the function from the table: the app's p_clashes is a hint only. Existing bookings on the mill (plain) and the lathe
  // (split by day, 038) at a time no other test uses.
  const WEEK = "2026-11-09T08:00:00Z";
  let millNo: string;
  let latheNo: string;
  beforeAll(async () => {
    const service = adminClient();
    millNo = `J-X1-${world.runId}`;
    latheNo = `J-X2-${world.runId}`;
    expect((await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: mill, job_no: millNo, description: "Existing", start_at: WEEK, estimated_hours: 4 })).error).toBeNull();
    expect((await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: lathe, job_no: latheNo, description: "Split", start_at: WEEK, estimated_hours: 8,
      day_plan: [{ date: "2026-11-09", start: "08:00", end: "12:00" }, { date: "2026-11-10", start: "08:00", end: "12:00" }] })).error).toBeNull();
    expect((await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: mill, job_no: `J-X3-${world.runId}`, description: "Done", start_at: "2026-11-16T08:00:00Z", estimated_hours: 4, status: "complete" })).error).toBeNull();
  });
  const over = (machine_id: string, start_at: string) => [{ machine_id, hours: 1, start_at }];

  it("are found by the database: office and workshop sending no clashes are refused, with the machine_clash hint, even asking to override", async () => {
    for (const role of ["office", "workshop"]) {
      const r = await create(as[role], { p_machines: over(mill, WEEK), p_clashes: [], p_clash_override: true });
      expect(r.error?.code).toBe("42501");
      expect(r.error?.hint).toBe("machine_clash");
      expect(r.error?.message).toContain(millNo);
      // A start inside the second day of the split booking, and one inside the first booking's last hour.
      expect((await create(as[role], { p_machines: over(lathe, "2026-11-10T09:00:00Z"), p_clashes: [] })).error?.hint).toBe("machine_clash");
      expect((await create(as[role], { p_machines: over(mill, "2026-11-09T11:30:00Z"), p_clashes: [] })).error?.hint).toBe("machine_clash");
    }
    const admin = await create(as.admin, { p_machines: over(mill, WEEK), p_clashes: [], p_clash_override: false });
    expect(admin.error?.hint).toBe("machine_clash");
    // Nothing was written and no number was taken.
    const service = adminClient();
    expect((await service.from("machine_bookings").select("id").eq("organization_id", world.tenants.alpha.id).eq("machine_id", mill).gte("start_at", WEEK).lt("start_at", "2026-11-16T00:00:00Z")).data).toHaveLength(1);
  });

  it("a free slot, a complete booking and the end of a booking don't clash, for the office", async () => {
    expect((await create(as.office, { p_machines: over(mill, "2026-11-09T12:00:00Z"), p_clashes: [] })).error).toBeNull();
    expect((await create(as.office, { p_machines: over(mill, "2026-11-16T08:00:00Z"), p_clashes: [] })).error).toBeNull();
    expect((await create(as.office, { p_machines: over(lathe, "2026-11-10T12:00:00Z"), p_clashes: [] })).error).toBeNull();
  });

  it("two jobs asked for the same machine and time at the same moment: exactly one is made, the other is refused as a clash", async () => {
    // Two signed-in connections (office and workshop) through PostgREST at once, on a slot nothing else uses. The per-company lock makes
    // the second call's clash check run after the first has committed, whichever arrives first.
    for (const [i, slot] of ["2026-11-23T08:00:00Z", "2026-11-23T13:00:00Z"].entries()) {
      const [a, b] = await Promise.all([
        create(as.office, { p_description: `Race A${i}`, p_machines: [{ machine_id: lathe, hours: 2, start_at: slot }], p_clashes: [] }),
        create(as.workshop, { p_description: `Race B${i}`, p_internal: true, p_customer: null, p_machines: [{ machine_id: lathe, hours: 2, start_at: slot }], p_clashes: [] }),
      ]);
      const outcomes = [a, b].map((r) => (r.error ? r.error.hint : "created"));
      expect(outcomes.sort()).toEqual(["created", "machine_clash"]);
      const made = [a, b].find((r) => !r.error)!.data;
      const service = adminClient();
      expect((await service.from("machine_bookings").select("job_no").eq("organization_id", world.tenants.alpha.id).eq("machine_id", lathe).eq("start_at", slot)).data).toEqual([{ job_no: made.job_no }]);
    }
  });

  it("the app's clash hint is capped at 20000 characters", async () => {
    const long = Array.from({ length: 150 }, (_, i) => ({ machine_id: mill, job_no: `J-${String(i).padStart(4, "0")}-${"x".repeat(200)}` }));
    const r = await create(as.admin, { p_machines: over(mill, "2026-11-30T08:00:00Z"), p_clashes: long, p_clash_override: true });
    expect(r.error?.code).toBe("22023");
    expect(r.error?.message).toContain("too long");
    expect((await create(as.admin, { p_machines: over(mill, "2026-11-30T08:00:00Z"), p_clashes: long.slice(0, 50), p_clash_override: true })).error).toBeNull();
  });

  it("an admin's override needs a reason: none, blank or too short is refused and nothing is written", async () => {
    const attempt = { p_machines: over(mill, "2026-11-09T10:00:00Z"), p_clashes: [], p_clash_override: true };
    for (const p_override_reason of [null, "", "   ", "ab"]) {
      const r = await create(as.admin, { ...attempt, p_override_reason });
      expect(r.error?.code, String(p_override_reason)).toBe("22023");
      expect(r.error?.hint).toBe("override_reason");
    }
    expect((await create(as.admin, { ...attempt, p_override_reason: "x".repeat(501) })).error?.code).toBe("22023");
    // A reason doesn't help the office: not an admin.
    expect((await create(as.office, { ...attempt, p_override_reason: "Customer waiting" })).error?.hint).toBe("machine_clash");
    expect((await adminClient().from("machine_bookings").select("id").eq("organization_id", world.tenants.alpha.id).eq("machine_id", mill).eq("start_at", "2026-11-09T10:00:00+00:00")).data).toEqual([]);
  });
  it("an admin can book anyway with a reason, and that is audited with the bookings the database found, who and when", async () => {
    const before = new Date();
    const { data, error } = await create(as.admin, { p_machines: [{ machine_id: mill, hours: 2, start_at: "2026-11-09T10:00:00Z" }, { machine_id: lathe, hours: 1, start_at: "2026-11-10T09:00:00Z" }],
      p_clashes: [{ machine_id: mill, job_no: "J-GUESS" }], p_clash_override: true, p_override_reason: "  Customer waiting on this part  " });
    expect(error).toBeNull();
    const rows = await withDb((db) => db.query("select action, actor_user_id, metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action in ('CREATE_JOB', 'OVERRIDE_MACHINE_CLASH') order by action", [data.job_id]));
    expect(rows.rows.map((r) => r.action)).toEqual(["CREATE_JOB", "OVERRIDE_MACHINE_CLASH"]);
    expect(rows.rows[1].actor_user_id).toBe(world.tenants.alpha.users.admin.id);
    const meta = rows.rows[1].metadata;
    expect(meta.clashing_job_nos).toEqual([millNo, latheNo].sort());
    expect(meta.client_clashes).toEqual([{ machine_id: mill, job_no: "J-GUESS" }]);
    expect(meta.reason).toBe("Customer waiting on this part");
    expect(meta.actor_user_id).toBe(world.tenants.alpha.users.admin.id);
    expect(new Date(meta.at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
    // The bookings found: id, job number and the exact times each occupies (the split booking: its two days).
    const service = adminClient();
    const millBooking = (await service.from("machine_bookings").select("id").eq("job_no", millNo).single()).data!.id;
    const latheBooking = (await service.from("machine_bookings").select("id").eq("job_no", latheNo).single()).data!.id;
    const byJob = Object.fromEntries((meta.conflicts as { job_no: string; booking_id: string; machine_id: string; intervals: [string, string][] }[]).map((c) => [c.job_no, c]));
    expect(byJob[millNo]).toMatchObject({ booking_id: millBooking, machine_id: mill });
    expect(byJob[millNo].intervals.map((i) => i.map((t) => new Date(t).toISOString()))).toEqual([["2026-11-09T08:00:00.000Z", "2026-11-09T12:00:00.000Z"]]);
    expect(byJob[latheNo]).toMatchObject({ booking_id: latheBooking, machine_id: lathe });
    expect(byJob[latheNo].intervals.map((i) => i.map((t) => new Date(t).toISOString()))).toEqual([["2026-11-09T08:00:00.000Z", "2026-11-09T12:00:00.000Z"], ["2026-11-10T08:00:00.000Z", "2026-11-10T12:00:00.000Z"]]);
    expect(rows.rows[0].metadata).toMatchObject({ job_no: data.job_no, internal: false });
  });
});

describe("the table, the second step and dates", () => {
  it("job_machines takes no insert, update or delete from any role", async () => {
    const service = adminClient();
    const row = (await service.from("job_machines").select("id, job_id, machine_id").eq("organization_id", world.tenants.alpha.id).limit(1).single()).data!;
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      expect((await as[role].from("job_machines").update({ estimated_hours: 99 }).eq("id", row.id)).error?.code).toBe("42501");
      expect((await as[role].from("job_machines").delete().eq("id", row.id)).error?.code).toBe("42501");
      expect((await as[role].from("job_machines").insert({ organization_id: world.tenants.alpha.id, job_id: row.job_id, machine_id: lathe, estimated_hours: 1 })).error?.code).toBe("42501");
    }
    expect(Number((await service.from("job_machines").select("estimated_hours").eq("id", row.id).single()).data!.estimated_hours)).not.toBe(99);
  });

  it("an admin at aal1 is refused when the company requires the second step", async () => {
    await setRequireAdminMfaForTest(world.tenants.alpha.id, true);
    try {
      const r = await create(as.admin, { p_internal: true, p_customer: null });
      expect(r.error?.code).toBe("42501");
      expect(r.error?.hint).toBe("mfa_required");
    } finally {
      await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = $1", [world.tenants.alpha.id]));
    }
  });

  it("the date required and every start must fall in 2000..2100", async () => {
    expect((await create(as.admin, { p_required: "1999-12-31" })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_required: "2101-01-01" })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_machines: [{ machine_id: mill, hours: 1, start_at: "1999-12-31T23:00:00Z" }] })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_machines: [{ machine_id: mill, hours: 1, start_at: "2101-01-01T00:00:00Z" }] })).error?.code).toBe("22023");
    expect((await create(as.admin, { p_required: "2100-12-31", p_machines: [{ machine_id: mill, hours: 1, start_at: "2100-12-31T08:00:00Z" }] })).error).toBeNull();
    expect((await create(as.admin, { p_required: "2000-01-01", p_machines: [{ machine_id: mill, hours: 1, start_at: "2000-01-01T00:00:00Z" }] })).error).toBeNull();
  });
});

describe("internal and related", () => {
  it("is_internal never changes after the job is created", async () => {
    const { data } = await create(as.admin, { p_internal: true, p_customer: null });
    const flip = await as.admin.from("jobs").update({ is_internal: false }).eq("id", data.job_id).select("id");
    expect(flip.error?.code).toBe("42501");
    const other = await create(as.admin);
    expect((await as.admin.from("jobs").update({ is_internal: true }).eq("id", other.data.job_id).select("id")).error?.code).toBe("42501");
    // Other edits to an internal job still work.
    expect((await as.admin.from("jobs").update({ description: "Fixture plate" }).eq("id", data.job_id).select("id")).error).toBeNull();
  });

  it("links a related job in the same company, never another company's or itself", async () => {
    const target = await create(as.office);
    const { data, error } = await create(as.workshop, { p_internal: true, p_customer: null, p_related: target.data.job_id, p_description: "Rework tooling" });
    expect(error).toBeNull();
    expect((await as.viewer.from("jobs").select("related_job_id").eq("id", data.job_id).single()).data!.related_job_id).toBe(target.data.job_id);
    expect((await as.viewer.from("jobs").select("id").eq("related_job_id", target.data.job_id)).data!.map((r) => r.id)).toEqual([data.job_id]);
    expect((await create(as.admin, { p_related: betaJob })).error?.code).toBe("P0002");
    expect((await as.admin.from("jobs").update({ related_job_id: betaJob }).eq("id", data.job_id).select("id")).error).not.toBeNull();
    expect((await as.admin.from("jobs").update({ related_job_id: data.job_id }).eq("id", data.job_id).select("id")).error?.code).toBe("23514");
  });
});

describe("the schedule's own rule decides a clash (working days, hours per day, split days, Europe/London)", () => {
  // Fresh machines (8 hours a day, Monday to Friday, the table's defaults) so nothing else on them.
  let wk: string;
  let bst: string;
  let split: string;
  beforeAll(async () => {
    const service = adminClient();
    const machine = async (name: string) => (await service.from("machines").insert({ organization_id: world.tenants.alpha.id, name: `${name} ${world.runId}` }).select("id").single()).data!.id as string;
    wk = await machine("Weekday mill");
    bst = await machine("Summer mill");
    split = await machine("Split mill");
    expect((await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: split, job_no: `J-SPL-${world.runId}`, description: "Saturday only", start_at: "2026-11-14T08:00:00Z", estimated_hours: 4,
      day_plan: [{ date: "2026-11-14", start: "08:00", end: "12:00" }] })).error).toBeNull();
  });
  const one = (machine_id: string, hours: number, start_at: string) => [{ machine_id, hours, start_at }];

  it("GMT: 16 hours from Friday 08:00 run Friday and Monday, so Monday morning is taken and Monday 16:00 is free", async () => {
    const fri = await create(as.office, { p_description: "Friday job", p_machines: one(wk, 16, "2026-11-06T08:00:00Z") });
    expect(fri.error).toBeNull();
    const mon = await create(as.office, { p_description: "Monday job", p_machines: one(wk, 2, "2026-11-09T09:00:00Z") });
    expect(mon.error?.hint).toBe("machine_clash");
    expect(mon.error?.message).toContain(fri.data.job_no);
    // The schedule draws a booking as one stretch from its start to its finish, so the weekend inside the Friday job is taken too
    // (a free day between two planned days is only free for a booking split by day).
    expect((await create(as.office, { p_description: "Saturday job", p_machines: one(wk, 2, "2026-11-07T08:00:00Z") })).error?.hint).toBe("machine_clash");
    expect((await create(as.office, { p_description: "Monday late", p_machines: one(wk, 1, "2026-11-09T16:00:00Z") })).error).toBeNull();
  });

  it("BST: the machine's day is 08:00 to 16:00 London time (07:00 to 15:00 UTC)", async () => {
    // July 2027 (ahead of today): a booking whose start has passed and isn't complete is drawn from now, as the schedule draws it.
    const fri = await create(as.office, { p_description: "July Friday", p_machines: one(bst, 16, "2027-07-02T07:00:00Z") });
    expect(fri.error).toBeNull();
    expect((await create(as.office, { p_description: "July Monday 15:30", p_machines: one(bst, 1, "2027-07-05T14:30:00Z") })).error?.hint).toBe("machine_clash");
    expect((await create(as.office, { p_description: "July Monday 16:00", p_machines: one(bst, 1, "2027-07-05T15:00:00Z") })).error).toBeNull();
  });

  it("a booking split by day takes exactly its days", async () => {
    expect((await create(as.office, { p_description: "Saturday clash", p_machines: one(split, 1, "2026-11-14T09:00:00Z") })).error?.hint).toBe("machine_clash");
    expect((await create(as.office, { p_description: "Saturday after", p_machines: one(split, 1, "2026-11-14T12:00:00Z") })).error).toBeNull();
  });
});

describe("security regression", () => {
  it("cross-company job, machine and related-job ids are refused, nothing of the other company changes", async () => {
    const service = adminClient();
    const betaBefore = (await service.from("machine_bookings").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.beta.id)).count;
    expect((await create(as.admin, { p_machines: [{ machine_id: betaMachine, hours: 1, start_at: START }] })).error?.code).toBe("P0002");
    expect((await create(as.admin, { p_related: betaJob })).error?.code).toBe("P0002");
    expect((await create(as.betaAdmin, { p_machines: [{ machine_id: mill, hours: 1, start_at: START }] })).error?.code).toBe("P0002");
    expect((await create(as.betaAdmin, { p_related: (await service.from("jobs").select("id").eq("organization_id", world.tenants.alpha.id).limit(1).single()).data!.id })).error?.code).toBe("P0002");
    expect((await service.from("machine_bookings").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.beta.id)).count).toBe(betaBefore);
  });

  it("the viewer can't call create_job; the workshop and the viewer can't write job_machines", async () => {
    expect((await create(as.viewer, { p_internal: true, p_customer: null })).error?.code).toBe("42501");
    const service = adminClient();
    const row = (await service.from("job_machines").select("id, job_id").eq("organization_id", world.tenants.alpha.id).limit(1).single()).data!;
    for (const role of ["workshop", "viewer"]) {
      expect((await as[role].from("job_machines").insert({ organization_id: world.tenants.alpha.id, job_id: row.job_id, machine_id: lathe, estimated_hours: 1 })).error?.code).toBe("42501");
      expect((await as[role].from("job_machines").update({ estimated_hours: 50 }).eq("id", row.id)).error?.code).toBe("42501");
      expect((await as[role].from("job_machines").delete().eq("id", row.id)).error?.code).toBe("42501");
    }
  });

  it("no commercial value reaches the workshop or the viewer through create_job, job_machines, machine_bookings or the booking functions", async () => {
    const money = /price|value|amount|total|cost|rate|margin|vat|discount/i;
    const columns = await withDb((db) => db.query<{ table_name: string; column_name: string }>("select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('job_machines', 'machine_bookings') order by 1, 2"));
    expect(columns.rows.filter((c) => money.test(c.column_name))).toEqual([]);
    const made = await create(as.workshop, { p_internal: true, p_customer: null, p_description: "Keys check" });
    expect(Object.keys(made.data).sort()).toEqual(["job_id", "job_no"]);
    const args = await withDb((db) => db.query<{ proname: string; args: string }>("select p.proname, pg_get_function_result(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_job', 'save_machine_booking', 'delete_machine_booking', 'booking_intervals')"));
    expect(args.rows.map((r) => r.proname).sort()).toEqual(["booking_intervals", "create_job", "delete_machine_booking", "save_machine_booking"]);
    for (const role of ["workshop", "viewer"]) {
      const rows = (await as[role].from("job_machines").select("*").eq("organization_id", world.tenants.alpha.id).limit(1)).data ?? [];
      for (const r of rows) expect(Object.keys(r).filter((k) => money.test(k))).toEqual([]);
      const bookings = (await as[role].from("machine_bookings").select("*").eq("organization_id", world.tenants.alpha.id).limit(1)).data ?? [];
      for (const r of bookings) expect(Object.keys(r).filter((k) => money.test(k))).toEqual([]);
    }
  });
});

describe("the migration on a database with data", () => {
  it("runs again over existing bookings and customer jobs without touching them (safe to run twice), with the grants as expected", async () => {
    const dir = path.join(__dirname, "../../supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_internal_jobs_and_machines.sql"))!;
    const text = readFileSync(path.join(dir, file), "utf8");
    const service = adminClient();
    // Rows as a live company has them before the release: a customer job made by hand and a booking on it, plus everything made above.
    const legacyJob = (await service.from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-LEG-${world.runId}`, customer: "Legacy Ltd", description: "Pre-release" }).select("id").single()).data!.id;
    expect((await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: lathe, job_id: legacyJob, job_no: `J-LEG-${world.runId}`, start_at: "2026-12-21T08:00:00Z", estimated_hours: 3 })).error).toBeNull();
    const fingerprint = "select (select count(*) from public.jobs) as jobs, (select count(*) from public.machine_bookings) as bookings, (select count(*) from public.job_machines) as links, (select md5(string_agg(id::text || coalesce(customer, '') || is_internal::text || coalesce(related_job_id::text, ''), ',' order by id)) from public.jobs) as jobs_fp, (select md5(string_agg(id::text || machine_id::text || start_at::text || estimated_hours::text || status || coalesce(day_plan::text, ''), ',' order by id)) from public.machine_bookings) as bookings_fp, (select md5(string_agg(id::text || machine_id::text || estimated_hours::text || coalesce(booking_id::text, ''), ',' order by id)) from public.job_machines) as links_fp, (select array_agg(privilege_type::text order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'machine_bookings' and grantee = 'authenticated') as booking_grants, (select array_agg(privilege_type::text order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'job_machines' and grantee = 'authenticated') as link_grants";
    await withDb(async (db) => {
      await db.query("begin");
      try {
        const before = (await db.query(fingerprint)).rows[0];
        expect(before.booking_grants).toEqual(["SELECT"]);
        expect(before.link_grants).toEqual(["SELECT"]);
        await db.query(text);
        expect((await db.query(fingerprint)).rows[0]).toEqual(before);
        const fns = await db.query<{ n: number }>("select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('create_job', 'save_machine_booking', 'delete_machine_booking', 'booking_intervals', 'job_despatch_billing_guard')");
        expect(fns.rows[0].n).toBe(5);
      } finally {
        await db.query("rollback");
      }
    });
    expect((await service.from("jobs").select("customer, is_internal").eq("id", legacyJob).single()).data).toEqual({ customer: "Legacy Ltd", is_internal: false });
  });
});

describe("verify script", () => {
  it("is clean on the test stack", async () => {
    const text = readFileSync(path.join(__dirname, "../../supabase/verify/internal_jobs_and_machines.sql"), "utf8");
    const rows = await withDb((db) => db.query<{ n: number; check_name: string; value: string; expected: string }>(text));
    const facts = rows.rows.filter((r) => r.expected === "true");
    expect(facts.length).toBeGreaterThanOrEqual(8);
    expect(facts.filter((r) => r.value !== "true")).toEqual([]);
  });
});
