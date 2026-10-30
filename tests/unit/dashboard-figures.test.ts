/**
 * E6: the dashboard's figures from migration 111's functions (lib/dashboard-figures.ts).
 *
 *   - Parity: the figures built from 111's answer for the two-company proof's alpha rows (the expected JSON is read from
 *     tests/scripts/dashboard-figures-111.proof.sql, which proves the database returns exactly that) equal the figures the old
 *     browser-side reads (lib/dashboard-figures-legacy.ts, the code moved verbatim from the page) work out from the same rows.
 *   - Fallback: while the database doesn't have 111's functions the loader uses the old reads, and keeps doing so; once they are
 *     there it uses them (the office dashboard never asks for the money figures); any other failure blanks that half only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Op = [string, unknown[]];
type Answer = { data: unknown; count?: number | null; error: null };

const h = vi.hoisted(() => {
  const state = { resolve: ((): Answer => ({ data: [], error: null })) as (table: string, ops: Op[]) => Answer, reads: 0 };
  const builder = (table: string) => {
    const ops: Op[] = [];
    const self: Record<string, unknown> = {};
    for (const name of ["select", "eq", "neq", "or", "is", "gte", "lt", "order", "limit", "not"]) {
      self[name] = (...args: unknown[]) => { ops.push([name, args]); return self; };
    }
    self.range = (from: number, to: number) => { ops.push(["range", [from, to]]); return self; };
    self.then = (ok: (value: Answer) => unknown, fail: (err: unknown) => unknown) => {
      state.reads += 1;
      try {
        const answer = state.resolve(table, ops);
        const range = ops.find(([name]) => name === "range");
        const data = range && Array.isArray(answer.data) ? answer.data.slice(range[1][0] as number, (range[1][1] as number) + 1) : answer.data;
        return Promise.resolve({ ...answer, data }).then(ok, fail);
      } catch (err) {
        return Promise.reject(err).then(ok, fail);
      }
    };
    return self;
  };
  return { state, client: { from: (table: string) => builder(table) } };
});
vi.mock("@/lib/supabase", () => ({ supabase: h.client }));

import { adminDataFrom, createAdminDataLoader, dashboardDates, moneyArgs, sixMonths, workArgs, type FiguresClient, type MoneyFigures, type WorkFigures } from "@/lib/dashboard-figures";
import { lastSixMonths, loadAdminData as legacyLoad, type AdminData } from "@/lib/dashboard-figures-legacy";

const NOW = new Date("2026-10-30T12:00:00Z");
const PROOF = readFileSync(path.resolve(__dirname, "../scripts/dashboard-figures-111.proof.sql"), "utf8");
const literal = (name: string) => JSON.parse(new RegExp(`${name} jsonb := '([\\s\\S]*?)';`).exec(PROOF)![1]);
const LATHE = "00000000-0000-4000-8000-0000000000a1";
const MILL = "00000000-0000-4000-8000-0000000000a2";
// The proof's expected alpha answers; its machines (checked there without their ids) with ids put back.
const WORK: WorkFigures = { ...literal("v_work"), machines: [
  { id: LATHE, name: "Lathe", hours_per_day: 8, working_days: [1, 2, 3, 4, 5], booked: 7.5 },
  { id: MILL, name: "Mill", hours_per_day: 7.5, working_days: [1, 2, 3, 4], booked: 0 },
] };
const MONEY: MoneyFigures = literal("v_money");

// ---- the same alpha rows, as each of the old reads gets them from the API (its filter applied: the database's part) -----------------
const ts = (s: string) => `${s.replace(" ", "T")}:00+00:00`;
const QUOTES = [
  { id: "q1", quote_ref: "QUO-1", version: 1, status: "sent", valid_until: "2026-11-30", total_value: 100, vat_enabled: true, sent_at: ts("2026-10-05 09:00"), rfq_id: null, created_at: ts("2026-10-01 09:00") },
  { id: "q2", quote_ref: "QUO-2", version: 1, status: "sent", valid_until: "2026-10-01", total_value: 50, vat_enabled: true, sent_at: ts("2026-09-01 09:00"), rfq_id: null, created_at: ts("2026-09-01 09:00") },
  { id: "q3", quote_ref: "QUO-3", version: 1, status: "accepted", valid_until: "2026-10-01", total_value: 200, vat_enabled: true, sent_at: ts("2026-10-10 09:00"), rfq_id: "r1", created_at: ts("2026-10-01 09:00") },
  { id: "q4", quote_ref: "QUO-3 v2", version: 2, status: "sent", valid_until: null, total_value: 250, vat_enabled: true, sent_at: ts("2026-10-12 09:00"), rfq_id: null, created_at: ts("2026-10-12 09:00") },
  { id: "q5", quote_ref: "QUO-5", version: 1, status: "draft", valid_until: "2026-10-01", total_value: 70, vat_enabled: true, sent_at: null, rfq_id: null, created_at: ts("2026-09-01 09:00") },
  { id: "q6", quote_ref: "QUO-6", version: 1, status: "rejected", valid_until: null, total_value: 30, vat_enabled: true, sent_at: ts("2026-07-15 09:00"), rfq_id: "r2", created_at: ts("2026-07-01 09:00") },
  { id: "q7", quote_ref: "QUO-7", version: 1, status: "SENT", valid_until: null, total_value: 10, vat_enabled: true, sent_at: null, rfq_id: null, created_at: ts("2026-10-01 09:00") },
  { id: "q8", quote_ref: "QUO-8", version: 1, status: "draft", valid_until: "2026-10-01", total_value: 15, vat_enabled: true, sent_at: ts("2026-09-10 09:00"), rfq_id: null, created_at: ts("2026-09-01 09:00") },
];
const RFQS = [{ id: "r1", status: "new" }, { id: "r2", status: "new" }, { id: "r3", status: "new" }, { id: "r4", status: "quoted" }, { id: "r5", status: "" }, { id: "r6", status: "clarification" }];
const job = (id: string, stage: string, started: string | null, finished: string | null, inspected: string | null, required: string | null, due: string | null) =>
  ({ id, stage, started_at: started && ts(started), finished_at: finished && ts(finished), inspected_at: inspected && ts(inspected), flow_status: null, date_required: required, due_date: due });
const OPEN_JOBS = [
  job("j1", "material", null, null, null, "2026-10-29", "2026-10-29"),
  job("j2", "machining", "2026-10-20 08:00", null, null, "2026-11-02", "2026-11-02"),
  job("j3", "inspection", "2026-10-20 08:00", "2026-10-28 10:00", null, "2026-10-27", "2026-10-27"),
  job("j4", "rework", "2026-10-01 08:00", "2026-10-14 10:00", "2026-10-15 10:00", null, "2026-11-10"),
  job("j7", "material", null, null, null, null, null),
  job("j8", "material", null, null, null, null, "2026-11-06"),
  job("j9", "setup", null, null, null, null, "2026-10-01"),
];
const FINISHED_JOBS = [
  { id: "j3", finished_at: ts("2026-10-28 10:00"), date_required: "2026-10-27", due_date: "2026-10-27" },
  { id: "j4", finished_at: ts("2026-10-14 10:00"), date_required: null, due_date: "2026-11-10" },
  { id: "j5", finished_at: ts("2026-09-18 10:00"), date_required: "2026-09-19", due_date: "2026-09-19" },
];
const INSPECTIONS = [
  { id: "i1", job_id: "j3", result: "fail", inspected_at: ts("2026-10-01 10:00") }, { id: "i2", job_id: "j3", result: "pass", inspected_at: ts("2026-10-05 10:00") },
  { id: "i3", job_id: "j5", result: "pass", inspected_at: ts("2026-09-20 10:00") }, { id: "i5", job_id: "j4", result: "fail", inspected_at: ts("2026-10-15 10:00") },
];
const MACHINES = [{ id: LATHE, name: "Lathe", hours_per_day: 8, working_days: [1, 2, 3, 4, 5] }, { id: MILL, name: "Mill", hours_per_day: 7.5, working_days: [1, 2, 3, 4] }];
const BOOKINGS = [{ id: "b1", machine_id: LATHE, start_at: ts("2026-10-27 09:00"), estimated_hours: 4.5 }, { id: "b2", machine_id: LATHE, start_at: ts("2026-10-31 09:00"), estimated_hours: 3 }];
const inv = (id: string, status: string, total: number, paid: number, credited: number, refunded: number, due: string | null, unverified = false) =>
  ({ id, invoice_ref: id, customer: "Acme", total, status, amount_paid: paid, credited_amount: credited, refunded_amount: refunded, due_date: due, payment_unverified: unverified });
const UNPAID = [
  inv("v1", "issued", 120, 20, 0, 0, "2026-11-15"), inv("v2", "partial", 300, 100, 50, 10, "2026-10-20"), inv("v3", "issued", 80, 0, 0, 0, "2026-09-15"),
  inv("v4", "overdue", 40, 0, 0, 0, "2026-07-01"), inv("v5", "issued", 999, 0, 0, 0, "2026-10-01", true), inv("v6", "draft", 500, 0, 0, 0, "2026-10-01"),
  inv("v7", "void", 70, 0, 0, 0, "2026-10-01"), inv("v8", "issued", 50, 60, 0, 0, "2026-10-01"), inv("v9", "issued", 25, 0, 0, 0, null),
];
const PAID = [
  { id: "p1", customer: "Acme ", total: 500, paid_at: ts("2026-09-11 12:00"), invoice_date: "2026-09-01", created_at: ts("2026-09-01 08:00") },
  { id: "p2", customer: "Acme", total: 250, paid_at: ts("2026-10-05 00:00"), invoice_date: "2026-10-01", created_at: ts("2026-10-01 08:00") },
  { id: "p4", customer: "Zed Ltd", total: 900, paid_at: ts("2026-06-01 10:00"), invoice_date: null, created_at: ts("2026-03-01 08:00") },
  { id: "p5", customer: "  ", total: 50, paid_at: ts("2026-05-20 00:00"), invoice_date: "2026-05-10", created_at: ts("2026-05-10 08:00") },
  { id: "p6", customer: "Old Co", total: 70, paid_at: null, invoice_date: "2026-06-01", created_at: ts("2026-06-01 08:00") },
];
const PAYMENTS = [{ id: "y1", amount: 100, paid_on: "2026-10-02" }, { id: "y2", amount: 50.5, paid_on: "2026-09-15" }, { id: "y4", amount: 20.25, paid_on: "2026-10-20" }];

const has = (ops: Op[], name: string, first?: unknown) => ops.some(([n, args]) => n === name && (first === undefined || args[0] === first));
const isHead = (ops: Op[]) => ops.some(([n, args]) => n === "select" && (args[1] as { head?: boolean } | undefined)?.head === true);
const rows = (data: unknown[]): Answer => ({ data, error: null });
const count = (n: number): Answer => ({ data: null, count: n, error: null });

/** Which rows each of the old reads gets: the counts and rows the proof's hand count says for alpha. */
function legacyAnswers(table: string, ops: Op[]): Answer {
  const orArg = String(ops.find(([n]) => n === "or")?.[1][0] ?? "");
  if (table === "quote_line_items") return rows([]);
  if (table === "quotes") return rows(QUOTES);
  if (table === "rfqs") return rows(RFQS);
  if (table === "email_history") return count(2);
  if (table === "machines") return rows(MACHINES);
  if (table === "machine_bookings") return rows(BOOKINGS);
  if (table === "job_inspections") return rows(INSPECTIONS);
  if (table === "invoice_payments") return rows(PAYMENTS);
  if (table === "jobs") {
    if (!isHead(ops)) return rows(has(ops, "gte", "finished_at") ? FINISHED_JOBS : OPEN_JOBS);
    if (orArg === "stage.eq.rework,inspected_at.is.null") return count(7);
    if (orArg.startsWith("and(stage.eq.rework")) return count(2);
    if (orArg.startsWith("date_required.lt.")) return count(2);
    if (orArg === "date_required.not.is.null,due_date.not.is.null") return count(4);
  }
  if (table === "invoices") {
    if (isHead(ops)) return count(6);
    if (has(ops, "neq", "status")) return rows(UNPAID);
    if (has(ops, "eq", "status")) return rows(PAID);
  }
  throw new Error(`unexpected read of ${table}: ${JSON.stringify(ops)}`);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

describe("dashboard figures from migration 111 (E6)", () => {
  it("reads the proof's expected answers (machines as the proof checks them)", () => {
    expect(WORK.quotes.open_count).toBe(3);
    expect(MONEY.owed_pence).toBe(40500);
    expect(PROOF).toContain('[{"name": "Lathe", "hours_per_day": 8, "working_days": [1,2,3,4,5], "booked": 7.5}, {"name": "Mill", "hours_per_day": 7.5, "working_days": [1,2,3,4], "booked": 0}]');
  });

  it("works out the six months exactly as the old reads did", () => {
    expect(sixMonths(NOW)).toEqual(lastSixMonths());
    const d = dashboardDates(NOW);
    expect(workArgs(d)).toEqual({
      p_today: "2026-10-30", p_week_end: "2026-11-06", p_since: "2026-05-01", p_month_start: "2026-10-01", p_quotes_since: "2026-08-01",
      p_week_start: d.monday.toISOString(), p_week_stop: d.sunday.toISOString(), p_now: NOW.toISOString(),
    });
    expect(moneyArgs(d)).toEqual({ p_today: "2026-10-30", p_since: "2026-05-01" });
    expect(d.monday.getDay()).toBe(1);
  });

  it("gives the owner's dashboard the same figures the old reads worked out from the same rows", async () => {
    h.state.resolve = legacyAnswers;
    const before = await legacyLoad(false);
    const after = adminDataFrom(WORK, MONEY, false, dashboardDates(NOW));
    expect(after).toEqual(before);
    // And they are the hand-counted figures, not two equal blanks.
    expect(after).toMatchObject({ openQuotes: 3, pipelineValue: 360, moneyOwed: 405, unpaidInvoices: 6, rfqsToQuote: 3, openJobs: 7, dueThisWeek: 2, quotesSentThisMonth: 2, lateJobs: 2, onTimeJobs: 2, draftEmails: 2, thisMonthRevenue: 120.25 });
    expect(after.attention.map((a) => a.key)).toEqual(["inv-payment-to-confirm"]);
    expect(after.quotes90?.winRate).toBe(50);
    expect(after.machines?.map((m) => [m.name, m.booked, m.percent])).toEqual([["Lathe", 7.5, 19], ["Mill", 0, 0]]);
  });

  it("gives the office dashboard the same figures as the old reads, and no money figures", async () => {
    h.state.resolve = legacyAnswers;
    const before = await legacyLoad(true);
    expect(adminDataFrom(WORK, null, true, dashboardDates(NOW))).toEqual(before);
    expect(before.moneyOwed).toBeNull();
  });
});

describe("the dashboard loader", () => {
  const legacyData = { openQuotes: -1 } as unknown as AdminData;
  const setup = (answer: (fn: string) => { data: unknown; error: { code?: string; message?: string } | null }) => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client: FiguresClient = { rpc: (fn, args) => { calls.push([fn, args]); return Promise.resolve(answer(fn)); } };
    const legacy = vi.fn(async () => legacyData);
    const load = createAdminDataLoader({ client: () => client, legacy, now: () => NOW });
    return { calls, legacy, load };
  };
  const present = (fn: string) => ({ data: fn === "dashboard_work_figures" ? WORK : MONEY, error: null });

  it("uses 111's functions when the database has them: two requests for the owner, one for the office", async () => {
    const { calls, legacy, load } = setup(present);
    expect(await load(false)).toEqual(adminDataFrom(WORK, MONEY, false, dashboardDates(NOW)));
    expect(calls.map(([fn]) => fn)).toEqual(["dashboard_work_figures", "dashboard_money_figures"]);
    expect(calls[0][1]).toEqual(workArgs(dashboardDates(NOW)));
    expect(calls[1][1]).toEqual(moneyArgs(dashboardDates(NOW)));
    calls.length = 0;
    expect((await load(true)).moneyOwed).toBeNull();
    expect(calls.map(([fn]) => fn)).toEqual(["dashboard_work_figures"]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("falls back to the old reads while 111 is not applied (function missing), and stays on them", async () => {
    const { calls, legacy, load } = setup(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.dashboard_work_figures in the schema cache" } }));
    expect(await load(false)).toBe(legacyData);
    expect(legacy).toHaveBeenCalledWith(false);
    const asked = calls.length;
    expect(await load(true)).toBe(legacyData);
    expect(legacy).toHaveBeenLastCalledWith(true);
    expect(calls.length).toBe(asked);
  });

  it("falls back when only the money function is missing (42883 from an older database)", async () => {
    const { legacy, load } = setup((fn) => (fn === "dashboard_money_figures" ? { data: null, error: { code: "42883", message: "function public.dashboard_money_figures(date, date) does not exist" } } : present(fn)));
    expect(await load(false)).toBe(legacyData);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("blanks only the failed half on any other error, and never falls back for it", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { legacy, load } = setup((fn) => (fn === "dashboard_money_figures" ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : present(fn)));
    const data = await load(false);
    expect(legacy).not.toHaveBeenCalled();
    expect(data.openJobs).toBe(7);
    expect(data.moneyOwed).toBeNull();
    expect(data.owedByAge).toBeNull();
    expect(data.attentionFailed).toBe(true);
    quiet.mockRestore();
  });
});
