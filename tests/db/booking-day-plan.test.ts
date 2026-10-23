/**
 * Split a machine booking by day (the booking day-plan migration), through the real API path: Supabase Auth + PostgREST with a signed-in synthetic
 * user, so the database's own rules are under test.
 *
 *   * a well-formed day_plan of {date, start, end} is accepted (weekend days, one day 00:00 to 24:00, 62 days, part hours to the
 *     minute, overnight work as two days); NULL stays the default rule;
 *   * a malformed one is refused with the check-constraint error: not a list, empty, more than 62 days, a day that is not an object
 *     with exactly "date", "start" and "end", an impossible or oddly written date or time, dates out of order or twice, an end at or
 *     before the start (no overnight wrap), and minutes that don't add up to round(estimated_hours * 60) (on insert and on update);
 *   * changing estimated_hours under an existing plan is refused unless the plan moves with it; clearing the plan returns to the default;
 *   * the write rules are the ones machine bookings always had (admin, office and workshop write; the viewer reads; anon nothing), and
 *     another company can neither read, change nor create a booking with a plan;
 *   * the read-only verify script is clean.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let alphaMachine: string;
let betaMachine: string;
let counter = 0;

const CHECK_VIOLATION = "23514";
/** One day of a plan: `date` worked from `start` to `end` (wall clock). */
const d = (date: string, start: string, end: string) => ({ date, start, end });
const SAT_SUN = [d("2026-10-10", "08:00", "14:00"), d("2026-10-11", "08:00", "10:00")];

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  const service = adminClient();
  alphaMachine = (await service.from("machines").insert({ organization_id: world.tenants.alpha.id, name: `Mill ${world.runId}` }).select("id").single()).data!.id;
  betaMachine = (await service.from("machines").insert({ organization_id: world.tenants.beta.id, name: `Beta Mill ${world.runId}` }).select("id").single()).data!.id;
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const outcome = (r: { error: { code?: string; message?: string } | null }) => ({ code: r.error?.code ?? null, message: r.error?.message ?? null });

/** A booking row for company alpha (or beta), with the given plan and hours. */
function row(plan: unknown, hours: number, org = world.tenants.alpha.id, machine = alphaMachine) {
  counter += 1;
  return { organization_id: org, machine_id: machine, job_no: `J-DP-${world.runId}-${counter}`, start_at: "2026-10-10T08:00:00Z", estimated_hours: hours, day_plan: plan };
}
/** A machine of its own per booking: the database refuses a second booking over the same time (042), and these tests are about the plan. */
async function freshMachine(org = world.tenants.alpha.id) {
  counter += 1;
  return (await adminClient().from("machines").insert({ organization_id: org, name: `Plan mill ${world.runId}-${counter}` }).select("id").single()).data!.id as string;
}
const saveArgs = (r: ReturnType<typeof row>, id: string | null = null) => ({
  p_id: id, p_machine: r.machine_id, p_job: null, p_job_no: r.job_no, p_description: null, p_start: r.start_at, p_hours: r.estimated_hours, p_hours_done: 0,
  p_status: "booked", p_notes: null, p_day_plan: r.day_plan ?? null, p_clear_day_plan: false, p_clash_override: false, p_override_reason: null,
});
/** Through save_machine_booking (042: the only way in for the API roles); the answer is shaped like the old insert's (a one-row list). */
async function insert(client: SupabaseClient, plan: unknown, hours: number, org = world.tenants.alpha.id, machine?: string) {
  const r = row(plan, hours, org, machine ?? (await freshMachine(org)));
  const { data, error } = await client.rpc("save_machine_booking", saveArgs(r));
  return { data: data ? [data as { id: string; day_plan: unknown }] : null, error };
}
/** The service role writes the table directly (it keeps its grants); the plan check applies to it too. */
const insertDirect = (plan: unknown, hours: number) => adminClient().from("machine_bookings").insert(row(plan, hours)).select("id, day_plan");
async function booking(plan: unknown = null, hours = 8, org = world.tenants.alpha.id, machine?: string) {
  const { data, error } = await adminClient().from("machine_bookings").insert(row(plan, hours, org, machine ?? (await freshMachine(org)))).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
/** An update as the schedule makes it: the stored row with the change, through save_machine_booking. */
async function update(client: SupabaseClient, id: string, patch: { day_plan?: unknown; estimated_hours?: number; status?: string; hours_done?: number }) {
  const cur = (await adminClient().from("machine_bookings").select("*").eq("id", id).single()).data!;
  const { error } = await client.rpc("save_machine_booking", {
    p_id: id, p_machine: cur.machine_id, p_job: cur.job_id, p_job_no: cur.job_no, p_description: cur.description, p_start: cur.start_at,
    p_hours: patch.estimated_hours ?? cur.estimated_hours, p_hours_done: patch.hours_done ?? cur.hours_done, p_status: patch.status ?? cur.status, p_notes: cur.notes,
    p_day_plan: "day_plan" in patch ? (patch.day_plan ?? null) : null, p_clear_day_plan: "day_plan" in patch && patch.day_plan === null, p_clash_override: false, p_override_reason: null,
  });
  return { error };
}
const del = (client: SupabaseClient, id: string) => client.rpc("delete_machine_booking", { p_id: id });
const stored = async (id: string) => (await adminClient().from("machine_bookings").select("day_plan, estimated_hours").eq("id", id).single()).data!;

describe("a well-formed plan is accepted", () => {
  it("Saturday and Sunday, stored exactly as sent", async () => {
    const r = await insert(as.admin, SAT_SUN, 8);
    expect(outcome(r)).toEqual({ code: null, message: null });
    expect(r.data![0].day_plan).toEqual(SAT_SUN);
  });

  it("one day 00:00 to 24:00, early and late times, part hours to the minute, and a plan that skips days", async () => {
    expect(outcome(await insert(as.admin, [d("2026-10-12", "00:00", "24:00")], 24))).toEqual({ code: null, message: null });
    expect(outcome(await insert(as.admin, [d("2026-10-12", "05:00", "22:00")], 17))).toEqual({ code: null, message: null });
    expect(outcome(await insert(as.admin, [d("2026-10-12", "08:00", "08:15"), d("2026-10-14", "08:00", "15:45")], 8))).toEqual({ code: null, message: null });
    expect(outcome(await insert(as.admin, [d("2026-02-28", "09:00", "10:00"), d("2028-02-29", "09:00", "10:00")], 2))).toEqual({ code: null, message: null }); // a real leap day
    expect(outcome(await insert(as.admin, [d("2026-10-12", "23:59", "24:00")], 0.02))).toEqual({ code: null, message: null }); // 1 minute = round(1.2)
  });

  it("overnight work is two days: 22:00-24:00 then 00:00-06:00", async () => {
    expect(outcome(await insert(as.admin, [d("2026-10-12", "22:00", "24:00"), d("2026-10-13", "00:00", "06:00")], 8))).toEqual({ code: null, message: null });
  });

  it("minutes are the source of truth: 3.33h is 200 minutes, and a float artefact in the estimate still rounds to it", async () => {
    expect(outcome(await insert(as.admin, [d("2026-10-10", "08:00", "11:20")], 3.33))).toEqual({ code: null, message: null });
    expect(outcome(await insert(as.admin, [d("2026-10-10", "08:00", "09:06"), d("2026-10-11", "08:00", "10:12")], 3.3))).toEqual({ code: null, message: null });
    expect((await as.admin.rpc("booking_day_plan_ok", { p_plan: [d("2026-10-10", "08:00", "11:20")], p_estimated_hours: 3.3333 })).data).toBe(true);
    expect((await as.admin.rpc("booking_day_plan_ok", { p_plan: [d("2026-10-10", "08:00", "11:19")], p_estimated_hours: 3.33 })).data).toBe(false);
  });

  it("62 days is the most", async () => {
    const days = (n: number) => Array.from({ length: n }, (_, i) => d(new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), "08:00", "09:00"));
    expect(outcome(await insert(as.admin, days(62), 62))).toEqual({ code: null, message: null });
    expect(outcome(await insert(as.admin, days(63), 63)).code).toBe(CHECK_VIOLATION);
  });

  it("dates from 2000-01-01 to 2100-12-31", async () => {
    expect(outcome(await insert(as.admin, [d("2000-01-01", "08:00", "12:00"), d("2100-12-31", "08:00", "12:00")], 8))).toEqual({ code: null, message: null });
  });

  it("no plan (NULL) is the default rule, and is what a booking made without one holds", async () => {
    const id = await booking();
    expect((await stored(id)).day_plan).toBeNull();
    const r = await insert(as.workshop, undefined, 5);
    expect(outcome(r)).toEqual({ code: null, message: null });
    expect(r.data![0].day_plan).toBeNull();
  });
});

describe("a malformed plan is refused", () => {
  const cases: [string, unknown, number][] = [
    ["an object, not a list", d("2026-10-10", "08:00", "16:00"), 8],
    ["a string", "2026-10-10", 8],
    ["an empty list", [], 8],
    ["a day that is not an object", ["2026-10-10"], 8],
    ["the old shape (date and hours)", [{ date: "2026-10-10", hours: 8 }], 8],
    ["a day without an end", [{ date: "2026-10-10", start: "08:00" }], 8],
    ["a day without a start", [{ date: "2026-10-10", end: "16:00" }], 8],
    ["a day without a date", [{ start: "08:00", end: "16:00" }], 8],
    ["an extra key on a day", [{ ...d("2026-10-10", "08:00", "16:00"), note: "x" }], 8],
    ["hours as well as times", [{ ...d("2026-10-10", "08:00", "16:00"), hours: 8 }], 8],
    ["a date that does not exist (30 February)", [d("2026-02-30", "08:00", "16:00")], 8],
    ["a date in a leap year that is not one (29 February 2026)", [d("2026-02-29", "08:00", "16:00")], 8],
    ["month 13", [d("2026-13-01", "08:00", "16:00")], 8],
    ["a date written day first", [d("10/10/2026", "08:00", "16:00")], 8],
    ["a date without leading zeros", [d("2026-1-5", "08:00", "16:00")], 8],
    ["a date with a time", [d("2026-10-10T08:00:00", "08:00", "16:00")], 8],
    ["a date that is not text", [{ date: 20261010, start: "08:00", end: "16:00" }], 8],
    ["a date before 2000", [d("1999-12-31", "08:00", "16:00")], 8],
    ["a date after 2100", [d("2101-01-01", "08:00", "16:00")], 8],
    ["dates in the wrong order", [d("2026-10-11", "08:00", "10:00"), d("2026-10-10", "08:00", "14:00")], 8],
    ["the same date twice", [d("2026-10-10", "08:00", "12:00"), d("2026-10-10", "13:00", "17:00")], 8],
    ["a start without a leading zero", [d("2026-10-10", "8:00", "16:00")], 8],
    ["a start with seconds", [d("2026-10-10", "08:00:00", "16:00")], 8],
    ["a start of 24:00", [d("2026-10-10", "24:00", "24:00")], 0],
    ["an hour of 25", [d("2026-10-10", "08:00", "25:00")], 17],
    ["minute 60", [d("2026-10-10", "08:00", "15:60")], 8],
    ["an end after 24:00", [d("2026-10-10", "16:00", "24:01")], 8.02],
    ["a time that is not text", [{ date: "2026-10-10", start: 800, end: "16:00" }], 8],
    ["a time that is null", [{ date: "2026-10-10", start: null, end: "16:00" }], 8],
    ["an end equal to the start", [d("2026-10-10", "08:00", "08:00"), d("2026-10-11", "08:00", "16:00")], 8],
    ["an end before the start", [d("2026-10-10", "16:00", "08:00")], 8],
    ["an overnight wrap (22:00 to 06:00 on one row)", [d("2026-10-10", "22:00", "06:00")], 8],
    ["an end of 00:00 (midnight is written 24:00)", [d("2026-10-10", "16:00", "00:00")], 8],
    ["minutes below the estimated hours", [d("2026-10-10", "08:00", "14:00"), d("2026-10-11", "08:00", "09:00")], 8],
    ["minutes above the estimated hours", [d("2026-10-10", "08:00", "14:00"), d("2026-10-11", "08:00", "11:00")], 8],
    ["minutes off by one", [d("2026-10-10", "08:00", "15:59")], 8],
  ];
  it.each(cases)("%s", async (_name, plan, hours) => {
    const before = (await adminClient().from("machine_bookings").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count;
    expect(outcome(await insertDirect(plan, hours)).code).toBe(CHECK_VIOLATION);
    expect(outcome(await insert(as.admin, plan, hours)).code).toBe(CHECK_VIOLATION);
    expect((await adminClient().from("machine_bookings").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count).toBe(before);
  });

  it("the JSON value null inside the column is not a plan either", async () => {
    // A JSON null (not SQL NULL) is not a list. SQL NULL is the default rule.
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await expect(db.query("insert into public.machine_bookings (organization_id, machine_id, start_at, estimated_hours, day_plan) values ($1, $2, now(), 8, 'null'::jsonb)", [world.tenants.alpha.id, alphaMachine]))
          .rejects.toMatchObject({ code: CHECK_VIOLATION });
      } finally {
        await db.query("rollback");
      }
    });
  });
});

describe("updates", () => {
  it("a plan can be added, changed with its hours, and cleared back to the default rule", async () => {
    const id = await booking();
    expect(outcome(await update(as.office, id, { day_plan: SAT_SUN }))).toEqual({ code: null, message: null });
    expect((await stored(id)).day_plan).toEqual(SAT_SUN);
    // Both together: 10 hours over three days.
    const three = [d("2026-10-10", "05:00", "09:00"), d("2026-10-11", "18:00", "22:00"), d("2026-10-12", "22:00", "24:00")];
    expect(outcome(await update(as.office, id, { estimated_hours: 10, day_plan: three }))).toEqual({ code: null, message: null });
    expect(await stored(id)).toEqual({ day_plan: three, estimated_hours: 10 });
    expect(outcome(await update(as.office, id, { day_plan: null }))).toEqual({ code: null, message: null });
    expect((await stored(id)).day_plan).toBeNull();
  });

  it("estimated hours can't change under a plan unless the plan changes too", async () => {
    const id = await booking(SAT_SUN, 8);
    expect(outcome(await update(as.office, id, { estimated_hours: 9 })).code).toBe(CHECK_VIOLATION);
    expect(outcome(await update(as.office, id, { day_plan: [d("2026-10-10", "08:00", "15:00"), d("2026-10-11", "08:00", "10:00")] })).code).toBe(CHECK_VIOLATION);
    expect(await stored(id)).toEqual({ day_plan: SAT_SUN, estimated_hours: 8 });
    // Status and hours done move freely under a plan.
    expect(outcome(await update(as.workshop, id, { status: "running", hours_done: 3 }))).toEqual({ code: null, message: null });
  });

  it("the change is written to the audit trail with the plan", async () => {
    const id = await booking();
    await update(as.admin, id, { day_plan: SAT_SUN });
    const rows = await withDb(async (db) => (await db.query("select new_data from security_audit.audit_log where entity_table = 'machine_bookings' and entity_id = $1 and action = 'UPDATE'", [id])).rows);
    expect(rows.length).toBe(1);
    expect(rows[0].new_data.day_plan).toEqual(SAT_SUN);
  });
});

describe("who can write, and whose bookings", () => {
  it("admin, office and workshop write a plan; the viewer reads it and writes nothing", async () => {
    for (const role of ["admin", "office", "workshop"] as const) {
      expect(outcome(await insert(as[role], SAT_SUN, 8)), role).toEqual({ code: null, message: null });
    }
    const id = await booking(SAT_SUN, 8);
    const viewerInsert = await insert(as.viewer, SAT_SUN, 8);
    expect(viewerInsert.error?.code).toBe("42501");
    // An update or delete by the viewer touches no row (row-level security hides them from the write).
    expect((await update(as.viewer, id, { day_plan: null })).error?.code).toBe("42501");
    expect((await del(as.viewer, id)).error?.code).toBe("42501");
    expect((await stored(id)).day_plan).toEqual(SAT_SUN);
    expect((await as.viewer.from("machine_bookings").select("day_plan").eq("id", id)).data).toEqual([{ day_plan: SAT_SUN }]);
    // Workshop can still delete (unchanged).
    expect((await del(as.workshop, id)).error).toBeNull();
    expect((await adminClient().from("machine_bookings").select("id").eq("id", id)).data).toEqual([]);
  });

  it("anon sees and writes nothing, and can't call the check function", async () => {
    const { apiUrl, anonKey } = isolatedBackend();
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const id = await booking(SAT_SUN, 8);
    const read = await anon.from("machine_bookings").select("day_plan").eq("id", id);
    expect(read.data ?? []).toEqual([]);
    expect((await anon.from("machine_bookings").insert(row(SAT_SUN, 8))).error).not.toBeNull();
    expect((await anon.rpc("booking_day_plan_ok", { p_plan: SAT_SUN, p_estimated_hours: 8 })).error).not.toBeNull();
    expect((await as.admin.rpc("booking_day_plan_ok", { p_plan: SAT_SUN, p_estimated_hours: 8 })).data).toBe(true);
    expect((await as.admin.rpc("booking_day_plan_ok", { p_plan: SAT_SUN, p_estimated_hours: 9 })).data).toBe(false);
  });

  it("another company can't read, change or delete a booking with a plan, or create one in this company", async () => {
    const mine = await booking(SAT_SUN, 8);
    const theirs = await booking([d("2026-10-13", "08:00", "16:00")], 8, world.tenants.beta.id, betaMachine);
    // beta's admin sees none of alpha's, alpha's admin none of beta's.
    expect((await as.betaAdmin.from("machine_bookings").select("id, day_plan").eq("id", mine)).data).toEqual([]);
    expect((await as.admin.from("machine_bookings").select("id, day_plan").eq("id", theirs)).data).toEqual([]);
    expect((await update(as.betaAdmin, mine, { day_plan: null })).error?.code).toBe("P0002");
    expect((await update(as.admin, theirs, { day_plan: null })).error?.code).toBe("P0002");
    expect((await del(as.admin, theirs)).error?.code).toBe("P0002");
    expect((await stored(mine)).day_plan).toEqual(SAT_SUN);
    expect((await stored(theirs)).day_plan).toEqual([d("2026-10-13", "08:00", "16:00")]);
    // Creating one in the other company, or on the other company's machine, is refused even with a valid plan.
    expect((await insert(as.admin, SAT_SUN, 8, world.tenants.beta.id, betaMachine)).error).not.toBeNull();
    expect((await insert(as.admin, SAT_SUN, 8, world.tenants.alpha.id, betaMachine)).error).not.toBeNull();
  });
});

describe("the catalogue", () => {
  it("machine_bookings keeps exactly its four tenant policies, and the plan check is the only new rule", async () => {
    const policies = await withDb(async (db) => (await db.query("select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'machine_bookings' order by policyname")).rows);
    expect(policies).toEqual([
      { policyname: "machine_bookings tenant delete", cmd: "DELETE" },
      { policyname: "machine_bookings tenant insert", cmd: "INSERT" },
      { policyname: "machine_bookings tenant select", cmd: "SELECT" },
      { policyname: "machine_bookings tenant update", cmd: "UPDATE" },
    ]);
  });

  it("the read-only verify script is clean", async () => {
    await booking(SAT_SUN, 8);
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/booking_day_plan.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin transaction read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    expect(rows.map((r) => Number(r.n))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const r of rows.filter((x) => x.expected === "true")) expect(r.value, r.check_name).toBe("true");
    expect(rows.filter((x) => x.expected === "true")).toHaveLength(7);
    expect(Number(rows.find((r) => Number(r.n) === 9)!.value)).toBeGreaterThan(0);
    expect(Number(rows.find((r) => Number(r.n) === 10)!.value)).toBeGreaterThan(0);
  });

  it("the verify script reports a bad plan if one gets in some other way (constraint dropped inside a rolled-back transaction)", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/booking_day_plan.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("alter table public.machine_bookings drop constraint machine_bookings_day_plan_check");
        await db.query("insert into public.machine_bookings (organization_id, machine_id, start_at, estimated_hours, day_plan) values ($1, $2, now(), 8, '[{\"date\":\"2026-10-10\",\"start\":\"08:00\",\"end\":\"11:00\"}]'::jsonb)", [world.tenants.alpha.id, alphaMachine]);
        return (await db.query<{ n: number; value: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    const value = (n: number) => rows.find((r) => Number(r.n) === n)!.value;
    expect(value(2)).toBe("false");
    expect(value(4)).toBe("false");
    expect(value(1)).toBe("true");
  });
});
