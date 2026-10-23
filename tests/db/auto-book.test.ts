/**
 * A machine picked on a job is booked at its NEXT FREE SLOT; a finished job comes off the schedule (migration 061, Rhys 15 Oct), through
 * the real API path (Supabase Auth + PostgREST with signed-in synthetic users), so the database's own rules are under test.
 *
 *   * set_job_machines: a machine just picked with no start goes on after every active booking on that machine, in its working hours
 *     and days (admin, office and workshop); explicit start wins; hours 0, auto_book false and a job's own schedule booking leave a plan
 *     row only (never a second booking); auto_book true books an existing plan row; running bookings count as busy and are never moved,
 *     complete ones don't count; a series and two at once never overlap; viewer, anon and another company are refused; the helper is
 *     no API role's to call;
 *   * convert_sales_order (and carry_so_machines): every carried machine booked the same way; retired or 0 h: plan row only;
 *   * finish_job: every booking of the job not yet complete completes (no run, a paused run), hours done kept; other jobs untouched;
 *     a second Finish changes nothing;
 *   * the read-only verify script is clean.
 * Every booking here is on a machine made for its own test, a week or more ahead, so the slots are exact whatever the time of day.
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
let n = 0;
/** Monday 08:00 UK time, two weeks ahead (from the database's clock). */
let MON = 0;
/** UK wall-clock time `day` days after that Monday at `hour` (calendar days, so a clock change in between is counted right). */
const AT = new Map<string, number>();
const at = (day: number, hour: number) => AT.get(`${day}/${hour}`)!;
const iso = (ms: number) => new Date(ms).toISOString();

const setJob = (client: SupabaseClient, jobId: string, machines: unknown, over: Record<string, unknown> = {}) =>
  client.rpc("set_job_machines", { p_job: jobId, p_machines: machines, p_clash_override: false, p_clashes: [], p_override_reason: null, ...over });
const finish = (client: SupabaseClient, job: string) => client.rpc("finish_job", { p_job: job, p_client_op_id: null, p_finished_at: null });
const alpha = () => world.tenants.alpha.id;

async function machine(options: { org?: string; hoursPerDay?: number; workingDays?: number[]; active?: boolean } = {}) {
  n += 1;
  const { data, error } = await adminClient().from("machines").insert({
    organization_id: options.org ?? alpha(), name: `AB Machine ${world.runId}-${n}`, active: options.active ?? true,
    hours_per_day: options.hoursPerDay ?? 8, working_days: options.workingDays ?? [1, 2, 3, 4, 5],
  }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
async function job(org = alpha()) {
  n += 1;
  const { data, error } = await adminClient().from("jobs").insert({ organization_id: org, job_no: `J-AB-${world.runId}-${n}`, customer: "Auto Book Co", description: `Auto book ${n}` }).select("id, job_no").single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, no: data.job_no as string };
}
/** A booking of another job, written as the service (as the schedule had it). */
async function booking(machineId: string, jobId: string | null, startMs: number, hours: number, status = "booked", hoursDone = 0) {
  const { data, error } = await adminClient().from("machine_bookings").insert({
    organization_id: alpha(), machine_id: machineId, job_id: jobId, job_no: `J-OTHER-${n}`, description: "Other", start_at: iso(startMs), estimated_hours: hours, hours_done: hoursDone, status,
  }).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}
const bookingsOf = async (jobId: string) => (await adminClient().from("machine_bookings").select("*").eq("job_id", jobId).order("start_at")).data!;
const planOf = async (jobId: string) => (await adminClient().from("job_machines").select("machine_id, estimated_hours, booking_id").eq("job_id", jobId).order("position")).data!;
const startOf = (b: { start_at: string }) => new Date(b.start_at).getTime();
/** Pairs of active bookings on the machine whose time overlaps, by the schedule's own rule (042 booking_intervals). */
const overlaps = (machineId: string) => withDb(async (db) => (await db.query(`
  select a.job_no as a, b.job_no as b from public.machine_bookings a join public.machine_bookings b on a.machine_id = b.machine_id and a.id < b.id
  join public.machines m on m.id = a.machine_id
  where a.machine_id = $1 and a.status <> 'complete' and b.status <> 'complete'
    and exists (select 1 from public.booking_intervals(a.start_at, a.estimated_hours, m.hours_per_day, m.working_days, a.day_plan, a.status, a.hours_done, now()) x,
                              public.booking_intervals(b.start_at, b.estimated_hours, m.hours_per_day, m.working_days, b.day_plan, b.status, b.hours_done, now()) y where x && y)`, [machineId])).rows);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  await withDb(async (db) => {
    const { rows } = await db.query<{ d: number; h: number; t: Date }>(`
      select d, h, ((date_trunc('week', now() at time zone 'Europe/London') + interval '14 days' + make_interval(days => d, hours => h)) at time zone 'Europe/London') as t
      from generate_series(0, 13) d, generate_series(0, 23) h`);
    for (const r of rows) AT.set(`${r.d}/${r.h}`, new Date(r.t).getTime());
  });
  MON = at(0, 8);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("a machine picked on a job goes on at its next free slot", () => {
  it.each(["admin", "office", "workshop"])("%s: after every active booking on the machine (a complete one doesn't count), for the job's hours", async (role) => {
    const m = await machine();
    const other = await job();
    // Another job: Monday 08:00 for 10 h (Mon 08-16, Tue 08-10). A complete booking a week later takes no time.
    await booking(m, other.id, MON, 10);
    await booking(m, other.id, at(7, 8), 8, "complete");
    const mine = await job();
    const { data, error } = await setJob(as[role], mine.id, [{ machine_id: m, hours: 4 }]);
    expect(error).toBeNull();
    const [b] = await bookingsOf(mine.id);
    expect(startOf(b)).toBe(at(1, 10)); // Tuesday 10:00
    expect(b).toMatchObject({ machine_id: m, job_no: mine.no, estimated_hours: 4, hours_done: 0, status: "booked" });
    expect(await planOf(mine.id)).toEqual([{ machine_id: m, estimated_hours: 4, booking_id: b.id }]);
    // The answer: 043's keys, plus auto_booked and the finish by the schedule's rule (Tuesday 14:00).
    expect(data.machines).toEqual([expect.objectContaining({ machine_id: m, hours: 4, booking_id: b.id, auto_booked: true, clashes: [] })]);
    expect(new Date(data.machines[0].start_at).getTime()).toBe(at(1, 10));
    expect(new Date(data.machines[0].finish_at).getTime()).toBe(at(1, 14));
    expect(Object.keys(data).sort()).toEqual(["job_id", "job_no", "machines", "removed"]);
    // The other job's booking never moved.
    const [kept] = await bookingsOf(other.id);
    expect(startOf(kept)).toBe(MON);
    expect(await overlaps(m)).toEqual([]);
    // Recorded: the job's SET_JOB_MACHINES event (with auto_booked) and the booking's own row audit.
    const events = await withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'SET_JOB_MACHINES'", [mine.id]));
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].metadata.after).toEqual([expect.objectContaining({ machine_id: m, auto_booked: true, booking_id: b.id })]);
    const rowAudit = await withDb((db) => db.query("select count(*)::int as n from security_audit.audit_log where entity_table = 'machine_bookings' and entity_id = $1", [b.id]));
    expect(rowAudit.rows[0].n).toBeGreaterThan(0);
  });

  it("respects the machine's working hours and days: a full day moves to the next working day, a weekend is skipped", async () => {
    // 6 h a day: Monday 08:00 for 6 h fills Monday, so the next slot is Tuesday 08:00.
    const short = await machine({ hoursPerDay: 6 });
    await booking(short, (await job()).id, MON, 6);
    const a = await job();
    expect((await setJob(as.office, a.id, [{ machine_id: short, hours: 2 }])).error).toBeNull();
    expect(startOf((await bookingsOf(a.id))[0])).toBe(at(1, 8));
    // Mon to Fri, 8 h: Friday 08:00 for 8 h fills Friday; the next slot is the Monday after, not Saturday.
    const weekday = await machine();
    await booking(weekday, (await job()).id, at(4, 8), 8);
    const b = await job();
    expect((await setJob(as.office, b.id, [{ machine_id: weekday, hours: 12 }])).error).toBeNull();
    const [made] = await bookingsOf(b.id);
    expect(startOf(made)).toBe(at(7, 8));
    // A machine that also works Saturdays takes the Saturday.
    const sixDay = await machine({ workingDays: [1, 2, 3, 4, 5, 6] });
    await booking(sixDay, (await job()).id, at(4, 8), 8);
    const c = await job();
    expect((await setJob(as.office, c.id, [{ machine_id: sixDay, hours: 1 }])).error).toBeNull();
    expect(startOf((await bookingsOf(c.id))[0])).toBe(at(5, 8));
    for (const id of [short, weekday, sixDay]) expect(await overlaps(id)).toEqual([]);
  });

  it("explicit start wins; hours 0 and auto_book false are plan rows only; auto_book true books an existing plan row; a job's own schedule booking is never doubled", async () => {
    const m1 = await machine();
    const m2 = await machine();
    const m3 = await machine();
    const m4 = await machine();
    await booking(m1, (await job()).id, MON, 8);
    const j = await job();
    const WED = at(9, 8); // a free Wednesday of the week after
    const { data, error } = await setJob(as.workshop, j.id, [
      { machine_id: m1, hours: 2, start_at: iso(WED) }, { machine_id: m2, hours: 0 }, { machine_id: m3, hours: 3, auto_book: false }]);
    expect(error).toBeNull();
    expect(data.machines.map((x: { auto_booked: boolean }) => x.auto_booked)).toEqual([false, false, false]);
    const made = await bookingsOf(j.id);
    expect(made.map((b) => [b.machine_id, startOf(b)])).toEqual([[m1, WED]]);
    expect((await planOf(j.id)).map((r) => [r.machine_id, r.booking_id !== null])).toEqual([[m1, true], [m2, false], [m3, false]]);
    // Saved again with the same rows: the existing plan rows stay plan rows (043's rule for a row already on the job).
    expect((await setJob(as.workshop, j.id, [{ machine_id: m1, hours: 2 }, { machine_id: m2, hours: 1 }, { machine_id: m3, hours: 3 }])).error).toBeNull();
    expect(await bookingsOf(j.id)).toHaveLength(1);
    // Asked for: the existing m3 row is booked at its next free slot.
    expect((await setJob(as.workshop, j.id, [{ machine_id: m1, hours: 2 }, { machine_id: m2, hours: 1 }, { machine_id: m3, hours: 3, auto_book: true }])).error).toBeNull();
    expect((await bookingsOf(j.id)).map((b) => b.machine_id).sort()).toEqual([m1, m3].sort());
    // A booking made on the schedule for this job on m4 (not linked to any plan row): adding m4 books nothing more.
    await booking(m4, j.id, at(2, 8), 2);
    expect((await setJob(as.workshop, j.id, [{ machine_id: m1, hours: 2 }, { machine_id: m2, hours: 1 }, { machine_id: m3, hours: 3 }, { machine_id: m4, hours: 2 }])).error).toBeNull();
    expect((await bookingsOf(j.id)).filter((b) => b.machine_id === m4)).toHaveLength(1);
    // A bad auto_book is refused.
    expect((await setJob(as.workshop, j.id, [{ machine_id: m1, hours: 2, auto_book: "yes" }])).error?.code).toBe("22023");
  });

  it("a running booking counts as busy and is never moved; a complete one is free time", async () => {
    const m = await machine();
    const running = await booking(m, (await job()).id, MON, 6, "running", 1);
    await booking(m, (await job()).id, at(1, 8), 8, "complete");
    const j = await job();
    expect((await setJob(as.office, j.id, [{ machine_id: m, hours: 3 }])).error).toBeNull();
    // The running booking's remaining 5 h (estimate less hours done, from its start, which is ahead) end Monday 13:00; the complete Tuesday doesn't count.
    expect(startOf((await bookingsOf(j.id))[0])).toBe(at(0, 13));
    const { data: after } = await adminClient().from("machine_bookings").select("*").eq("id", running.id).single();
    expect(after).toMatchObject({ status: "running", start_at: running.start_at, estimated_hours: 6, hours_done: 1 });
    expect(await overlaps(m)).toEqual([]);
  });

  it("a series of jobs on one machine follow each other with no gap and no overlap", async () => {
    const m = await machine();
    await booking(m, (await job()).id, MON, 3);
    let expected = at(0, 11);
    for (let i = 0; i < 4; i += 1) {
      const j = await job();
      expect((await setJob(as.office, j.id, [{ machine_id: m, hours: 5 }])).error).toBeNull();
      const [b] = await bookingsOf(j.id);
      expect(startOf(b)).toBe(expected);
      // 5 h from the start, inside 08:00-16:00 working days; an end at the close of a day means the next starts the next working morning
      // (booking_normalise_start, the rule machine_next_free_start uses).
      const { data } = await setJob(as.office, j.id, [{ machine_id: m, hours: 5 }]);
      expect(data.machines[0].booking_id).toBe(b.id);
      expected = await withDb(async (db) => new Date((await db.query("select public.booking_normalise_start(max(upper(r)), 8, '{1,2,3,4,5}', false) as f from public.booking_intervals($1::timestamptz, 5, 8, '{1,2,3,4,5}', null, 'booked', 0, now()) r", [b.start_at])).rows[0].f).getTime());
    }
    expect(await overlaps(m)).toEqual([]);
  });

  it("two jobs booking the same machine at the same moment, from two sessions: both booked, one after the other, never overlapping", async () => {
    for (let round = 0; round < 3; round += 1) {
      const m = await machine();
      await booking(m, (await job()).id, MON, 2);
      const [a, b] = [await job(), await job()];
      const [ra, rb] = await Promise.all([setJob(as.admin, a.id, [{ machine_id: m, hours: 7 }]), setJob(as.office, b.id, [{ machine_id: m, hours: 7 }])]);
      expect(ra.error).toBeNull();
      expect(rb.error).toBeNull();
      const starts = [startOf((await bookingsOf(a.id))[0]), startOf((await bookingsOf(b.id))[0])].sort((x, y) => x - y);
      expect(starts[0]).toBe(at(0, 10));
      expect(starts[1]).toBe(at(1, 9)); // 7 h from Monday 10:00 ends Tuesday 09:00
      expect(await overlaps(m)).toEqual([]);
    }
  });

  it("viewer, anon and another company are refused; another company's bookings never move a slot; nobody runs the helper", async () => {
    const m = await machine();
    const j = await job();
    expect((await setJob(as.viewer, j.id, [{ machine_id: m, hours: 1 }])).error?.code).toBe("42501");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await setJob(anon, j.id, [{ machine_id: m, hours: 1 }])).error).not.toBeNull();
    expect((await setJob(as.betaAdmin, j.id, [{ machine_id: m, hours: 1 }])).error?.code).toBe("P0002");
    const betaJob = await job(world.tenants.beta.id);
    expect((await setJob(as.betaAdmin, betaJob.id, [{ machine_id: m, hours: 1 }])).error?.code).toBe("P0002");
    expect(await bookingsOf(j.id)).toEqual([]);
    expect(await bookingsOf(betaJob.id)).toEqual([]);
    // Beta's machine busy all next fortnight: alpha's slot on its own machine is unaffected (and beta's booking unchanged).
    const betaMachine = await machine({ org: world.tenants.beta.id });
    const { data: betaBooking } = await adminClient().from("machine_bookings").insert({ organization_id: world.tenants.beta.id, machine_id: betaMachine, job_id: betaJob.id, job_no: betaJob.no, start_at: iso(MON), estimated_hours: 80 }).select("*").single();
    await booking(m, (await job()).id, MON, 1);
    expect((await setJob(as.admin, j.id, [{ machine_id: m, hours: 1 }])).error).toBeNull();
    expect(startOf((await bookingsOf(j.id))[0])).toBe(at(0, 9));
    expect((await adminClient().from("machine_bookings").select("*").eq("id", betaBooking!.id).single()).data).toEqual(betaBooking);
    for (const c of [as.admin, as.office, as.workshop, as.viewer, anon]) {
      const r = await c.rpc("machine_next_free_start", { p_org: alpha(), p_machine: m, p_hours: 1, p_from: null, p_now: null });
      expect(r.error).not.toBeNull();
    }
  });
});

describe("a job made from a sales order books its planned machines", () => {
  async function plannedOrder(machines: { machine_id: string; hours: number }[]) {
    n += 1;
    const { data: order, error } = await adminClient().from("sales_orders").insert({
      organization_id: alpha(), so_number: `PO-AB-${world.runId}-${n}`, customer_po: `PO-AB-${world.runId}-${n}`, customer: "Auto Book Co", total_value: 100, status: "open", order_date: "2026-10-15",
    }).select("id").single();
    if (error) throw new Error(error.message);
    expect((await as.office.rpc("ensure_sales_order_lines", { p_order: order.id })).error).toBeNull();
    const { data: lines } = await adminClient().from("sales_order_lines").select("id").eq("sales_order_id", order.id).order("position");
    expect((await as.office.rpc("set_sales_order_line_machines", { p_order: order.id, p_line: lines![0].id, p_machines: machines })).error).toBeNull();
    return order.id as string;
  }

  it.each(["admin", "office"])("%s converts: each machine at its next free slot; 0 h and a machine retired since stay plan rows; the result is unchanged", async (role) => {
    const busy = await machine();
    const free = await machine();
    const zero = await machine();
    const old = await machine();
    await booking(busy, (await job()).id, MON, 8);
    const orderId = await plannedOrder([{ machine_id: busy, hours: 3 }, { machine_id: free, hours: 2 }, { machine_id: zero, hours: 0 }, { machine_id: old, hours: 1 }]);
    expect((await adminClient().from("machines").update({ active: false }).eq("id", old)).error).toBeNull();
    const { data, error } = await as[role].rpc("convert_sales_order", { p_order: orderId });
    expect(error).toBeNull();
    expect(data).toEqual({ job_id: expect.any(String), job_no: expect.stringMatching(/^J-/), created: true });
    const made = await bookingsOf(data.job_id);
    expect(made.map((b) => [b.machine_id, Number(b.estimated_hours), b.status, b.job_no])).toEqual(expect.arrayContaining([[busy, 3, "booked", data.job_no], [free, 2, "booked", data.job_no]]));
    expect(made).toHaveLength(2);
    expect(startOf(made.find((b) => b.machine_id === busy)!)).toBe(at(1, 8)); // Monday is full: Tuesday 08:00
    expect(await overlaps(busy)).toEqual([]);
    const plan = await planOf(data.job_id);
    expect(plan.map((r) => [r.machine_id, r.booking_id !== null])).toEqual([[busy, true], [free, true], [zero, false], [old, false]]);
    const carry = await withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'CARRY_MACHINES'", [data.job_id]));
    expect(carry.rows).toHaveLength(1);
    expect(carry.rows[0].metadata.machines_booked).toBe(2);
    expect(carry.rows[0].metadata.machines.map((x: { machine_id: string; booked: boolean; why: string | null }) => [x.machine_id, x.booked, x.why])).toEqual([
      [busy, true, null], [free, true, null], [zero, false, "no_hours"], [old, false, "machine_inactive"]]);
    // Converting again: same job, nothing more booked.
    expect((await as[role].rpc("convert_sales_order", { p_order: orderId })).data).toMatchObject({ job_id: data.job_id, created: false });
    expect(await bookingsOf(data.job_id)).toHaveLength(2);
  });

  it("workshop and viewer can't carry; another company can't convert or carry the order", async () => {
    const m = await machine();
    const orderId = await plannedOrder([{ machine_id: m, hours: 1 }]);
    expect((await as.viewer.rpc("convert_sales_order", { p_order: orderId })).error?.code).toBe("42501");
    expect((await as.workshop.rpc("convert_sales_order", { p_order: orderId })).error?.code).toBe("42501");
    expect((await as.betaAdmin.rpc("convert_sales_order", { p_order: orderId })).error?.code).toBe("P0002");
    const { data } = await as.admin.rpc("convert_sales_order", { p_order: orderId });
    expect((await as.workshop.rpc("carry_so_machines", { p_order: orderId, p_job: data.job_id })).error?.code).toBe("42501");
    expect((await as.betaAdmin.rpc("carry_so_machines", { p_order: orderId, p_job: data.job_id })).error?.code).toBe("P0002");
    expect(await bookingsOf(data.job_id)).toHaveLength(1);
  });
});

describe("a finished job comes off the schedule", () => {
  it("finish with no run completes every booking of the job; other jobs' bookings stay; a second Finish changes nothing", async () => {
    const m1 = await machine();
    const m2 = await machine();
    const j = await job();
    const other = await job();
    expect((await setJob(as.office, j.id, [{ machine_id: m1, hours: 3 }, { machine_id: m2, hours: 2, start_at: iso(at(2, 8)) }])).error).toBeNull();
    const otherBooking = await booking(m1, other.id, at(8, 8), 4);
    expect((await finish(as.viewer, j.id)).error?.code).toBe("42501");
    expect((await finish(as.betaAdmin, j.id)).error?.code).toBe("P0002");
    const { data, error } = await finish(as.workshop, j.id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ job_id: j.id, changed: true, ended: [] });
    expect(data.bookings_completed).toHaveLength(2);
    const after = await bookingsOf(j.id);
    expect(after.map((b) => [b.status, Number(b.hours_done)])).toEqual([["complete", 0], ["complete", 0]]);
    expect((await adminClient().from("machine_bookings").select("*").eq("id", otherBooking.id).single()).data).toEqual(otherBooking);
    const events = () => withDb((db) => db.query("select count(*)::int as n from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'FINISH_COMPLETES_BOOKINGS'", [j.id])).then((r) => r.rows[0].n);
    expect(await events()).toBe(1);
    // The finished job's time is free again: a new job on m1 goes only after the other job's booking (the one active booking left).
    const next = await job();
    expect((await setJob(as.office, next.id, [{ machine_id: m1, hours: 1 }])).error).toBeNull();
    expect(startOf((await bookingsOf(next.id))[0])).toBe(at(8, 12));
    // Again: nothing changes.
    const snapshot = await bookingsOf(j.id);
    const again = await finish(as.workshop, j.id);
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ changed: false, ended: [] });
    expect(await bookingsOf(j.id)).toEqual(snapshot);
    expect(await events()).toBe(1);
  });

  it("finish after a paused run completes the booking with the hours the run recorded", async () => {
    const m = await machine();
    const j = await job();
    expect((await setJob(as.office, j.id, [{ machine_id: m, hours: 4, start_at: iso(MON) }])).error).toBeNull();
    const start = await as.workshop.rpc("start_machine_run", { p_job: j.id, p_machines: [m], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null });
    expect(start.error).toBeNull();
    expect((await as.workshop.rpc("pause_machine_run", { p_job: j.id, p_machines: null, p_client_op_id: null, p_ended_at: null })).error).toBeNull();
    const [paused] = await bookingsOf(j.id);
    expect(paused.status).toBe("booked");
    const { data, error } = await finish(as.workshop, j.id);
    expect(error).toBeNull();
    expect(data.ended).toEqual([]);
    expect(data.bookings_completed).toEqual([expect.objectContaining({ booking_id: paused.id, mirrored: true, status: "complete" })]);
    const [done] = await bookingsOf(j.id);
    expect(done).toMatchObject({ id: paused.id, status: "complete", estimated_hours: 4, hours_done: paused.hours_done, start_at: paused.start_at });
  });
});

describe("verify script", () => {
  it("is clean on the test stack", async () => {
    const text = readFileSync(path.join(__dirname, "../../supabase/verify/auto_book_next_free.sql"), "utf8");
    const rows = await withDb((db) => db.query<{ n: number; check_name: string; value: string; expected: string }>(text));
    expect(rows.rows.length).toBe(11);
    expect(rows.rows.filter((r) => r.value !== r.expected)).toEqual([]);
  });
});
