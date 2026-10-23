/**
 * Machine bookings are written only through the database (migration 042): save_machine_booking and delete_machine_booking take the same
 * per-company lock as create_job, then check a clash against the schedule's own rule (booking_intervals, Europe/London), then write.
 *   * nothing writes machine_bookings directly: insert, update and delete are refused for every role (select stays);
 *   * admin, office and workshop book, edit and remove through the functions; the viewer can't; another company's machine, job or
 *     booking is refused;
 *   * a clash is refused for the office and the workshop; an admin books anyway only with a reason, recorded with the bookings found;
 *   * two saves for one slot at the same moment end as one booking and one refusal;
 *   * the SQL rule gives exactly the intervals lib/machine-schedule.ts gives, over fixtures with weekends, a non-working-day start,
 *     split days, both clock changes and a 24:00 end;
 *   * no commercial value is in the answer or the table.
 */
process.env.TZ = "Europe/London";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Booking, type Machine, DEFAULT_WORKING_DAYS, planSegments, scheduleBooking } from "../../lib/machine-schedule";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let m1: string;
let m2: string;
let m3: string;
let betaMachine: string;
let job: string;
let betaJob: string;

type SaveArgs = Record<string, unknown>;
const base = (over: SaveArgs = {}): SaveArgs => ({
  p_id: null, p_machine: m1, p_job: null, p_job_no: `J-BW-${world.runId}`, p_description: "Bracket", p_start: "2026-11-16T08:00:00Z", p_hours: 4, p_hours_done: 0,
  p_status: "booked", p_notes: null, p_day_plan: null, p_clear_day_plan: false, p_clash_override: false, p_override_reason: null, ...over,
});
const save = (client: SupabaseClient, over: SaveArgs = {}) => client.rpc("save_machine_booking", base(over));
const remove = (client: SupabaseClient, id: string) => client.rpc("delete_machine_booking", { p_id: id });

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  const service = adminClient();
  const machine = async (org: string, name: string) => (await service.from("machines").insert({ organization_id: org, name: `${name} ${world.runId}` }).select("id").single()).data!.id as string;
  m1 = await machine(world.tenants.alpha.id, "Writes mill");
  m2 = await machine(world.tenants.alpha.id, "Race mill");
  m3 = await machine(world.tenants.alpha.id, "Edit mill");
  betaMachine = await machine(world.tenants.beta.id, "Beta mill");
  job = (await service.from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-BW-${world.runId}`, customer: "Writes Ltd" }).select("id").single()).data!.id;
  betaJob = (await service.from("jobs").insert({ organization_id: world.tenants.beta.id, job_no: `J-BWB-${world.runId}`, customer: "Beta Ltd" }).select("id").single()).data!.id;
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("nothing writes machine_bookings directly", () => {
  it("insert, update and delete are refused for every role; select still works", async () => {
    const service = adminClient();
    const id = (await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: m3, job_no: `J-DIRECT-${world.runId}`, start_at: "2026-12-01T08:00:00Z", estimated_hours: 1 }).select("id").single()).data!.id;
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      expect((await as[role].from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: m3, job_no: "J-NO", start_at: "2026-12-02T08:00:00Z", estimated_hours: 1 })).error?.code, role).toBe("42501");
      expect((await as[role].from("machine_bookings").update({ estimated_hours: 9 }).eq("id", id)).error?.code, role).toBe("42501");
      expect((await as[role].from("machine_bookings").delete().eq("id", id)).error?.code, role).toBe("42501");
      if (role !== "viewer") expect((await as[role].from("machine_bookings").select("id").eq("id", id)).data).toEqual([{ id }]);
    }
    expect(Number((await service.from("machine_bookings").select("estimated_hours").eq("id", id).single()).data!.estimated_hours)).toBe(1);
    const grants = await withDb((db) => db.query<{ privilege_type: string }>("select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'machine_bookings' and grantee = 'authenticated' order by 1"));
    expect(grants.rows.map((r) => r.privilege_type)).toEqual(["SELECT"]);
  });
});

describe("booking through the database", () => {
  it("the office books, edits and removes; the viewer can't do any of it", async () => {
    const made = await save(as.office, { p_job: job });
    expect(made.error).toBeNull();
    expect(made.data).toMatchObject({ machine_id: m1, job_id: job, job_no: `J-BW-${world.runId}`, status: "booked" });
    expect(Number(made.data.estimated_hours)).toBe(4);
    const id = made.data.id as string;
    const edited = await save(as.office, { p_id: id, p_job: job, p_hours: 5, p_notes: "Fixture ready" });
    expect(edited.error).toBeNull();
    expect(edited.data).toMatchObject({ id, notes: "Fixture ready" });
    expect(Number(edited.data.estimated_hours)).toBe(5);
    expect((await save(as.workshop, { p_id: id, p_job: job, p_hours: 5, p_hours_done: 2, p_status: "running" })).error).toBeNull();
    expect((await save(as.viewer, { p_machine: m3, p_start: "2026-12-03T08:00:00Z" })).error?.code).toBe("42501");
    expect((await save(as.viewer, { p_id: id, p_job: job, p_hours: 5 })).error?.code).toBe("42501");
    expect((await remove(as.viewer, id)).error?.code).toBe("42501");
    expect((await remove(as.workshop, id)).error).toBeNull();
    expect((await remove(as.workshop, id)).error?.code).toBe("P0002");
  });

  it("a retired machine takes no new booking and nothing moved onto it; a booking already there stays editable", async () => {
    const service = adminClient();
    const retired = (await service.from("machines").insert({ organization_id: world.tenants.alpha.id, name: `Retired mill ${world.runId}`, active: false }).select("id").single()).data!.id as string;
    expect((await save(as.office, { p_machine: retired, p_start: "2026-12-08T08:00:00Z" })).error).toMatchObject({ code: "22023", hint: "machine_inactive" });
    const onM3 = await save(as.office, { p_machine: m3, p_start: "2026-12-09T08:00:00Z" });
    expect(onM3.error).toBeNull();
    expect((await save(as.office, { p_id: onM3.data.id, p_machine: retired, p_start: "2026-12-09T08:00:00Z" })).error).toMatchObject({ code: "22023", hint: "machine_inactive" });
    expect((await service.from("machine_bookings").select("machine_id").eq("id", onM3.data.id).single()).data!.machine_id).toBe(m3);
    // A booking on a machine retired since: its notes, hours and status can still change; it can't be moved to another retired machine.
    const soon = (await service.from("machines").insert({ organization_id: world.tenants.alpha.id, name: `Soon retired ${world.runId}` }).select("id").single()).data!.id as string;
    const onSoon = await save(as.office, { p_machine: soon, p_start: "2026-12-10T08:00:00Z" });
    expect(onSoon.error).toBeNull();
    expect((await service.from("machines").update({ active: false }).eq("id", soon)).error).toBeNull();
    expect((await save(as.office, { p_id: onSoon.data.id, p_machine: soon, p_start: "2026-12-10T08:00:00Z", p_hours: 5, p_notes: "Still here" })).error).toBeNull();
    expect((await save(as.office, { p_id: onSoon.data.id, p_machine: retired, p_start: "2026-12-10T08:00:00Z" })).error).toMatchObject({ code: "22023", hint: "machine_inactive" });
    expect((await save(as.office, { p_id: onSoon.data.id, p_machine: m3, p_start: "2026-12-11T08:00:00Z" })).error).toBeNull();
  });

  it("another company's machine, job or booking is refused", async () => {
    expect((await save(as.office, { p_machine: betaMachine })).error?.code).toBe("P0002");
    expect((await save(as.office, { p_job: betaJob })).error?.code).toBe("P0002");
    const mine = await save(as.office, { p_machine: m3, p_start: "2026-12-04T08:00:00Z" });
    expect(mine.error).toBeNull();
    expect((await save(as.betaAdmin, { p_id: mine.data.id, p_machine: betaMachine })).error?.code).toBe("P0002");
    expect((await remove(as.betaAdmin, mine.data.id)).error?.code).toBe("P0002");
    expect((await adminClient().from("machine_bookings").select("id").eq("id", mine.data.id)).data).toHaveLength(1);
  });

  it("a clash is refused for the office and the workshop; an admin needs a reason; the override is recorded with the bookings found", async () => {
    const first = await save(as.office, { p_job_no: `J-FIRST-${world.runId}`, p_start: "2026-11-17T08:00:00Z", p_hours: 4 });
    expect(first.error).toBeNull();
    for (const role of ["office", "workshop"]) {
      const r = await save(as[role], { p_job_no: "J-OVER", p_start: "2026-11-17T09:00:00Z", p_hours: 1, p_clash_override: true, p_override_reason: "Please" });
      expect(r.error?.code, role).toBe("42501");
      expect(r.error?.hint, role).toBe("machine_clash");
      expect(r.error?.message, role).toContain(`J-FIRST-${world.runId}`);
    }
    expect((await save(as.admin, { p_job_no: "J-OVER", p_start: "2026-11-17T09:00:00Z", p_hours: 1 })).error?.hint).toBe("machine_clash");
    for (const p_override_reason of [null, "", " ", "no"]) {
      const r = await save(as.admin, { p_job_no: "J-OVER", p_start: "2026-11-17T09:00:00Z", p_hours: 1, p_clash_override: true, p_override_reason });
      expect(r.error?.code, String(p_override_reason)).toBe("22023");
      expect(r.error?.hint).toBe("override_reason");
    }
    const before = new Date();
    const over = await save(as.admin, { p_job_no: `J-OVER-${world.runId}`, p_start: "2026-11-17T09:00:00Z", p_hours: 1, p_clash_override: true, p_override_reason: "Breakdown cover for the customer" });
    expect(over.error).toBeNull();
    const audit = await withDb((db) => db.query("select actor_user_id, metadata from security_audit.audit_log where action = 'OVERRIDE_MACHINE_CLASH' and entity_table = 'machine_bookings' and entity_id = $1", [over.data.id]));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_user_id).toBe(world.tenants.alpha.users.admin.id);
    const meta = audit.rows[0].metadata;
    expect(meta).toMatchObject({ booking_id: over.data.id, machine_id: m1, reason: "Breakdown cover for the customer", clashing_job_nos: [`J-FIRST-${world.runId}`], actor_user_id: world.tenants.alpha.users.admin.id, new: true });
    expect(new Date(meta.at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
    expect(meta.conflicts).toEqual([{ booking_id: first.data.id, job_no: `J-FIRST-${world.runId}`, intervals: [[expect.any(String), expect.any(String)]] }]);
    expect(meta.conflicts[0].intervals[0].map((t: string) => new Date(t).toISOString())).toEqual(["2026-11-17T08:00:00.000Z", "2026-11-17T12:00:00.000Z"]);
    // The same again for an edit: moving the first booking onto the override is checked (the office is refused); notes aren't.
    expect((await save(as.office, { p_id: first.data.id, p_job_no: `J-FIRST-${world.runId}`, p_start: "2026-11-17T08:00:00Z", p_hours: 4, p_notes: "Note only" })).error).toBeNull();
    expect((await save(as.office, { p_id: first.data.id, p_job_no: `J-FIRST-${world.runId}`, p_start: "2026-11-17T09:30:00Z", p_hours: 4 })).error?.hint).toBe("machine_clash");
    expect((await save(as.office, { p_id: first.data.id, p_job_no: `J-FIRST-${world.runId}`, p_start: "2026-11-17T13:00:00Z", p_hours: 1 })).error).toBeNull();
  });

  it("two saves for the same machine and time at the same moment: exactly one booking and one refusal", async () => {
    for (const [i, slot] of ["2026-11-18T08:00:00Z", "2026-11-18T13:00:00Z"].entries()) {
      const [a, b] = await Promise.all([
        save(as.office, { p_machine: m2, p_job_no: `J-RA${i}-${world.runId}`, p_start: slot, p_hours: 2 }),
        save(as.workshop, { p_machine: m2, p_job_no: `J-RB${i}-${world.runId}`, p_start: slot, p_hours: 2 }),
      ]);
      expect([a, b].map((r) => (r.error ? r.error.hint : "created")).sort()).toEqual(["created", "machine_clash"]);
      expect((await adminClient().from("machine_bookings").select("id").eq("organization_id", world.tenants.alpha.id).eq("machine_id", m2).eq("start_at", slot)).data).toHaveLength(1);
    }
  });

  it("two bookings over the repeated hour on 25 Oct 2026, at the same moment: exactly one wins", async () => {
    const service = adminClient();
    const dst = (await service.from("machines").insert({ organization_id: world.tenants.alpha.id, name: `DST mill ${world.runId}` }).select("id").single()).data!.id as string;
    const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ p_start: "2026-10-25T00:00:00Z", p_hours: 1, p_day_plan: [{ date: "2026-10-25", start: "01:00", end: "02:00" }] }, { p_start: "2026-10-25T00:00:00Z", p_hours: 1, p_day_plan: [{ date: "2026-10-25", start: "01:00", end: "02:00" }] }],
      // 01:30-02:30 (BST 01:30 = 00:30Z, to 02:30 GMT) against 00:30-01:45 (23:30Z to 00:45Z): they overlap on the clock the browser uses.
      [{ p_start: "2026-10-25T00:30:00Z", p_hours: 1, p_day_plan: [{ date: "2026-10-25", start: "01:30", end: "02:30" }] }, { p_start: "2026-10-24T23:30:00Z", p_hours: 1.25, p_day_plan: [{ date: "2026-10-25", start: "00:30", end: "01:45" }] }],
    ];
    for (const [i, [x, y]] of pairs.entries()) {
      const [a, b] = await Promise.all([
        save(as.office, { p_machine: dst, p_job_no: `J-DSTA${i}-${world.runId}`, ...x }),
        save(as.workshop, { p_machine: dst, p_job_no: `J-DSTB${i}-${world.runId}`, ...y }),
      ]);
      expect([a, b].map((r) => (r.error ? r.error.hint : "created")).sort(), `pair ${i}`).toEqual(["created", "machine_clash"]);
      const winner = [a, b].find((r) => !r.error)!.data;
      expect((await remove(as.office, winner.id)).error).toBeNull();
    }
  });

  it("the job's machine plan (job_machines) follows the schedule's edits of a booking made for it; other bookings change nothing there", async () => {
    const service = adminClient();
    const made = await as.office.rpc("create_job", { p_customer: "Plan Co", p_description: "Plan follows", p_internal: false, p_related: null, p_required: null,
      p_machines: [{ machine_id: m3, hours: 3, start_at: "2026-12-14T08:00:00Z" }, { machine_id: m1, hours: 2, start_at: "2026-12-14T08:00:00Z" }], p_clash_override: false, p_clashes: [], p_override_reason: null });
    expect(made.error).toBeNull();
    const jobId = made.data.job_id as string;
    const rows = async () => (await service.from("job_machines").select("id, machine_id, estimated_hours, booking_id, position").eq("job_id", jobId).order("position")).data!.map((r) => ({ ...r, estimated_hours: Number(r.estimated_hours) }));
    const first = (await rows())[0];
    const edit = (over: Record<string, unknown>) => save(as.office, { p_id: first.booking_id, p_job: jobId, p_job_no: made.data.job_no, p_machine: m3, p_start: "2026-12-14T08:00:00Z", p_hours: 3, ...over });
    // Hours.
    expect((await edit({ p_hours: 5 })).error).toBeNull();
    expect((await rows())[0]).toMatchObject({ id: first.id, machine_id: m3, estimated_hours: 5, booking_id: first.booking_id });
    // A split plan: the row takes the plan's total.
    expect((await edit({ p_hours: 6, p_day_plan: [{ date: "2026-12-15", start: "08:00", end: "14:00" }] })).error).toBeNull();
    expect((await rows())[0]).toMatchObject({ id: first.id, machine_id: m3, estimated_hours: 6 });
    // A move to a machine the job doesn't have: the row is re-pointed.
    expect((await edit({ p_machine: m2, p_hours: 6, p_day_plan: [{ date: "2026-12-15", start: "08:00", end: "14:00" }] })).error).toBeNull();
    expect((await rows())[0]).toMatchObject({ id: first.id, machine_id: m2, estimated_hours: 6 });
    // A move onto a machine the job already has: one row left for that machine, naming this booking.
    expect((await edit({ p_machine: m1, p_hours: 6, p_day_plan: [{ date: "2026-12-15", start: "08:00", end: "14:00" }] })).error).toBeNull();
    const merged = await rows();
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ machine_id: m1, estimated_hours: 6, booking_id: first.booking_id });
    // Notes and status don't touch the plan; a delete keeps the row and clears its booking.
    expect((await edit({ p_machine: m1, p_hours: 6, p_day_plan: [{ date: "2026-12-15", start: "08:00", end: "14:00" }], p_notes: "note", p_status: "running" })).error).toBeNull();
    expect((await rows())[0]).toMatchObject({ machine_id: m1, estimated_hours: 6, booking_id: first.booking_id });
    expect((await remove(as.office, first.booking_id)).error).toBeNull();
    expect((await rows())[0]).toMatchObject({ machine_id: m1, estimated_hours: 6, booking_id: null });
    // A booking made on the schedule for a job (before this migration, or now) has no plan row and gets none from an edit.
    const before = (await service.from("job_machines").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count;
    const legacy = (await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: m3, job_id: job, job_no: `J-BW-${world.runId}`, start_at: "2026-12-16T08:00:00Z", estimated_hours: 2 }).select("id").single()).data!.id;
    expect((await save(as.office, { p_id: legacy, p_job: job, p_machine: m2, p_start: "2026-12-16T08:00:00Z", p_hours: 4 })).error).toBeNull();
    expect((await service.from("job_machines").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count).toBe(before);
  });

  it("no commercial value in the answer or the table", async () => {
    const money = /price|value|amount|total|cost|rate|margin|vat|discount/i;
    const made = await save(as.workshop, { p_machine: m3, p_start: "2026-12-05T08:00:00Z" });
    expect(made.error).toBeNull();
    expect(Object.keys(made.data).filter((k) => money.test(k))).toEqual([]);
    const columns = await withDb((db) => db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'machine_bookings'"));
    expect(columns.rows.map((c) => c.column_name).filter((k) => money.test(k))).toEqual([]);
  });
});

describe("the SQL rule and lib/machine-schedule.ts give the same intervals (Europe/London)", () => {
  const machine = (over: Partial<Machine> = {}): Machine => ({ id: "m", name: "M", type: "", hoursPerDay: 8, workingDays: [...DEFAULT_WORKING_DAYS], active: true, ...over });
  const booking = (over: Partial<Booking> = {}): Booking => ({ id: "b", machineId: "m", jobId: null, jobNo: "J", description: "", startAt: "2026-11-03T08:00:00Z", estimatedHours: 3, hoursDone: 0, status: "booked", notes: "", dayPlan: null, ...over });
  const FAR = new Date("2026-01-01T00:00:00Z");
  const cases: { name: string; m: Machine; b: Booking; now: Date }[] = [
    { name: "a weekday morning", m: machine(), b: booking(), now: FAR },
    { name: "16h from Friday 08:00 spans the weekend to Monday 16:00", m: machine(), b: booking({ startAt: "2026-11-06T08:00:00Z", estimatedHours: 16 }), now: FAR },
    { name: "20h from Friday 08:00 ends Tuesday 12:00", m: machine(), b: booking({ startAt: "2026-11-06T08:00:00Z", estimatedHours: 20 }), now: FAR },
    { name: "a Saturday start on a Mon-Fri machine runs every day", m: machine(), b: booking({ startAt: "2026-11-07T08:00:00Z", estimatedHours: 12 }), now: FAR },
    { name: "a start before the machine's day moves to 08:00", m: machine(), b: booking({ startAt: "2026-11-03T06:00:00Z", estimatedHours: 2 }), now: FAR },
    { name: "a start after the machine's day moves to the next working day", m: machine(), b: booking({ startAt: "2026-11-06T17:00:00Z", estimatedHours: 2 }), now: FAR },
    { name: "a 12h/day machine working Mon-Sat", m: machine({ hoursPerDay: 12, workingDays: [1, 2, 3, 4, 5, 6] }), b: booking({ startAt: "2026-11-06T10:00:00Z", estimatedHours: 20 }), now: FAR },
    { name: "split days including Saturday", m: machine(), b: booking({ startAt: "2026-11-07T08:00:00Z", estimatedHours: 8, dayPlan: [{ date: "2026-11-07", start: "08:00", end: "14:00" }, { date: "2026-11-08", start: "08:00", end: "10:00" }] }), now: FAR },
    { name: "a 24:00 end", m: machine(), b: booking({ startAt: "2026-11-03T22:00:00Z", estimatedHours: 2, dayPlan: [{ date: "2026-11-03", start: "22:00", end: "24:00" }] }), now: FAR },
    { name: "a split day over the late-March clock change (00:00 to 03:00 is 3 wall-clock hours)", m: machine(), b: booking({ startAt: "2026-03-29T00:00:00Z", estimatedHours: 3, dayPlan: [{ date: "2026-03-29", start: "00:00", end: "03:00" }] }), now: FAR },
    { name: "a split day over the late-October clock change", m: machine(), b: booking({ startAt: "2026-10-24T23:00:00Z", estimatedHours: 3, dayPlan: [{ date: "2026-10-25", start: "00:00", end: "03:00" }] }), now: FAR },
    { name: "the default rule across the late-March change on a 24h every-day machine", m: machine({ hoursPerDay: 24, workingDays: [0, 1, 2, 3, 4, 5, 6] }), b: booking({ startAt: "2026-03-28T20:00:00Z", estimatedHours: 10 }), now: FAR },
    { name: "the default rule across the late-October change on a 24h every-day machine", m: machine({ hoursPerDay: 24, workingDays: [0, 1, 2, 3, 4, 5, 6] }), b: booking({ startAt: "2026-10-24T19:00:00Z", estimatedHours: 14 }), now: FAR },
    { name: "a Friday in BST: the day is 07:00 to 15:00 UTC", m: machine(), b: booking({ startAt: "2026-07-03T07:00:00Z", estimatedHours: 16 }), now: FAR },
    { name: "hours left counted from now once started", m: machine(), b: booking({ startAt: "2026-11-02T08:00:00Z", estimatedHours: 8, hoursDone: 2, status: "running" }), now: new Date("2026-11-02T10:00:00Z") },
    { name: "a running booking whose start has passed is drawn from now", m: machine(), b: booking({ startAt: "2026-11-02T08:00:00Z", estimatedHours: 8, status: "running" }), now: new Date("2026-11-03T09:00:00Z") },
    { name: "a complete booking keeps its planned stretch", m: machine(), b: booking({ startAt: "2026-11-02T08:00:00Z", estimatedHours: 8, hoursDone: 8, status: "complete" }), now: new Date("2026-11-20T09:00:00Z") },
    { name: "a machine with no working days is a plain stretch", m: machine({ workingDays: [] }), b: booking({ startAt: "2026-11-07T20:00:00Z", estimatedHours: 30 }), now: FAR },
    // The hour the clocks go back (25 Oct 2026, 01:00-02:00 twice): both sides take the EARLIER instant (BST), as the browser does.
    { name: "repeated hour: 01:00 to 01:30", m: machine(), b: booking({ startAt: "2026-10-25T00:00:00Z", estimatedHours: 0.5, dayPlan: [{ date: "2026-10-25", start: "01:00", end: "01:30" }] }), now: FAR },
    { name: "repeated hour: 01:30 to 01:59", m: machine(), b: booking({ startAt: "2026-10-25T00:30:00Z", estimatedHours: 0.48, dayPlan: [{ date: "2026-10-25", start: "01:30", end: "01:59" }] }), now: FAR },
    { name: "repeated hour: 01:59 to 02:00 (one wall-clock minute, an hour and a minute of real time)", m: machine(), b: booking({ startAt: "2026-10-25T00:59:00Z", estimatedHours: 0.02, dayPlan: [{ date: "2026-10-25", start: "01:59", end: "02:00" }] }), now: FAR },
    { name: "repeated hour: 00:30 to 02:30 across it", m: machine(), b: booking({ startAt: "2026-10-24T23:30:00Z", estimatedHours: 2, dayPlan: [{ date: "2026-10-25", start: "00:30", end: "02:30" }] }), now: FAR },
    { name: "repeated hour: 01:00 to 02:00 exactly", m: machine(), b: booking({ startAt: "2026-10-25T00:00:00Z", estimatedHours: 1, dayPlan: [{ date: "2026-10-25", start: "01:00", end: "02:00" }] }), now: FAR },
    { name: "the default rule across that night on a 24h every-day machine", m: machine({ hoursPerDay: 24, workingDays: [0, 1, 2, 3, 4, 5, 6] }), b: booking({ startAt: "2026-10-24T22:00:00Z", estimatedHours: 6 }), now: FAR },
    { name: "the default rule across that night: a Saturday start on a Mon-Fri machine runs into Sunday", m: machine(), b: booking({ startAt: "2026-10-24T12:00:00Z", estimatedHours: 6 }), now: FAR },
  ];

  it.each(cases)("$name", async ({ m, b, now }) => {
    const scheduled = scheduleBooking(b, m, now);
    const segments = planSegments(b.dayPlan);
    const expected = (segments.length ? segments : [{ start: scheduled.start, end: scheduled.finish }]).map((i) => [i.start.toISOString(), i.end.toISOString()]);
    const sql = await withDb((db) => db.query<{ lo: string; hi: string }>(
      "select lower(r) as lo, upper(r) as hi from public.booking_intervals($1, $2, $3, $4, $5, $6, $7, $8) as r order by 1",
      [b.startAt, b.estimatedHours, m.hoursPerDay, m.workingDays.map((d) => (d === 0 ? 7 : d)), b.dayPlan ? JSON.stringify(b.dayPlan) : null, b.status, b.hoursDone, now.toISOString()]));
    expect(sql.rows.map((r) => [new Date(r.lo).toISOString(), new Date(r.hi).toISOString()])).toEqual(expected.filter(([lo, hi]) => hi > lo));
  });

  it("a time the clocks skip doesn't exist; a plan made only of such times falls back to the default rule, as the app does", async () => {
    const moment = await withDb((db) => db.query<{ at: string | null; ok: string | null }>("select public.booking_local_moment('2026-03-29', 90)::text as at, public.booking_local_moment('2026-03-29', 180)::text as ok"));
    expect(moment.rows[0].at).toBeNull();
    expect(new Date(moment.rows[0].ok!).toISOString()).toBe("2026-03-29T02:00:00.000Z");
    // planSegments skips the day, scheduleBooking then uses the default rule: one stretch from the start.
    const m = machine();
    const b = booking({ startAt: "2026-03-30T08:00:00Z", estimatedHours: 1, dayPlan: [{ date: "2026-03-29", start: "01:30", end: "02:30" }] });
    expect(planSegments(b.dayPlan)).toEqual([]);
    const scheduled = scheduleBooking(b, m, FAR);
    const sql = await withDb((db) => db.query<{ lo: string; hi: string }>("select lower(r)::text as lo, upper(r)::text as hi from public.booking_intervals($1, 1, 8, '{1,2,3,4,5}', $2, 'booked', 0, $3) as r",
      [b.startAt, JSON.stringify(b.dayPlan), FAR.toISOString()]));
    expect(sql.rows.map((r) => [new Date(r.lo).toISOString(), new Date(r.hi).toISOString()])).toEqual([[scheduled.start.toISOString(), scheduled.finish.toISOString()]]);
  });
});
