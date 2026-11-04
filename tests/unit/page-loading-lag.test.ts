/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAll } from "@/lib/fetch-all";
import * as dates from "@/lib/dates";
import * as tiles from "@/lib/dashboard-tile-figures";
import * as analytics from "@/lib/dashboard-analytics";
import * as metrics from "@/lib/overview-metrics";
import * as jobFlow from "@/lib/job-flow";
import * as jobStatus from "@/lib/job-status";
import { awaitingApproval } from "@/lib/approval-queue";
import { missingDbObject } from "@/lib/db-features";
import { toPence } from "@/lib/money";

const dashboardPath = "app/(dashboard)/dashboard/page.tsx";
const jobsPath = "app/(dashboard)/jobs/page.tsx";

// Run the actual local page functions without mounting unrelated charts/dialogs.
// Do not copy a second implementation or add invalid exports to a Next page.
function pageFunctions(path: string, names: string[], bindings: Record<string, unknown>) {
  const source = readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = tree.statements.filter((node) =>
    (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && names.includes(d.name.text))),
  );
  expect(declarations).toHaveLength(names.length);
  const code = ts.transpileModule(declarations.map((node) => node.getText(tree)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(`${code}\n;({${names.join(",")}})`, { ...bindings, Date, console }) as Record<string, (...args: any[]) => any>;
}

const job = {
  id: "job-1", job_no: "JOB-17", customer: "Practice customer", description: "Bracket", stage: "finished",
  status: "at_risk", due_date: "2026-11-03", date_required: "2026-11-02", started_at: "2026-11-02T08:00:00Z",
  finished_at: "2026-11-03T15:00:00Z", inspected_at: "2026-11-03T15:30:00Z", inspected_by: "Inspector",
  finished_by: "person-1", specification: "Sample", drawings: ["drawing.pdf"], customer_po: "PO-1",
  date_received: "2026-11-01", quote_ref: "Q-1", quantity_required: 0, drawing_no: "D-1", is_internal: false,
  related_job_id: "job-2", assigned_to: "person-1", converted_from_sales_order_id: "so-1",
  organization_id: "company-1", created_at: "2026-11-01T08:00:00Z", worksheet_version: 3,
};
const invoice = { id: "inv-1", job_id: job.id, customer: job.customer, total: 120, subtotal: 100, vat: 20, carriage: 0, status: "paid", paid_at: "2026-11-03", invoice_date: "2026-11-01", created_at: "2026-11-01", payment_unverified: false };
const quoteAnswers: Record<string, unknown> = {
  dashboard_open_quotes: { open_count: 2, open_pence: 12345, accepted_count: 1 },
  dashboard_quotes_sent: { count: 3 }, dashboard_quotes_won: { count: 1, undated: 1 },
  dashboard_quote_outcomes: { accepted: 1, sent: 2, expired: 1, rejected: 1, expired_sent: 1 },
  dashboard_rfqs_to_quote: { outstanding: 2 },
  dashboard_money_owed: { to_confirm: 1, invoices: 2, owed_pence: 54321, not_due: 10000, late_1_30: 44321, late_31_60: 0, late_60_plus: 0 },
};

function dashboardHarness(failTable?: string, holdQuote?: Promise<unknown>) {
  const started: string[] = [], requests: string[] = [];
  const rows: Record<string, any[]> = {
    jobs: [job], job_inspections: [{ id: "inspect-1", job_id: job.id, result: "pass", inspected_at: job.inspected_at }],
    machines: [{ id: "machine-1", name: "Lathe", hours_per_day: 8, working_days: [1, 2, 3, 4, 5] }],
    machine_bookings: [{ id: "booking-1", machine_id: "machine-1", start_at: "2026-11-03T08:00:00Z", estimated_hours: 2 }],
    invoices: [invoice], invoice_payments: [{ amount: 120, paid_on: "2026-11-03" }],
    credit_notes: [{ id: "credit-1", customer: job.customer, total: 12, vat: 2, status: "issued", credit_date: "2026-11-02" }],
    machine_runs: [{ id: "run-1", job_id: job.id, machine_id: "machine-1", started_at: "2026-11-02T08:00:00Z", ended_at: "2026-11-02T10:00:00Z" }],
    overview_owed_snapshots: [{ snapshot_date: "2026-11-03", owed_amount: 543.21, late_amount: 443.21 }],
    job_machines: [{ id: "plan-1", job_id: job.id, estimated_hours: 3 }],
  };
  const client = {
    from(table: string) {
      started.push(table);
      let from = 0, to = Infinity, head = false;
      const query: any = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve: any, reject: any) => {
          requests.push(table);
          const error = table === failTable ? { message: "read failed", code: "XX000" } : null;
          return Promise.resolve({ data: error || head ? null : (rows[table] ?? []).slice(from, to + 1), count: head && !error ? 4 : null, error }).then(resolve, reject);
        };
        return (...args: any[]) => {
          if (key === "range") [from, to] = args;
          if (key === "select") head = args[1]?.head === true;
          return query;
        };
      } });
      return query;
    },
    async rpc(name: string) {
      started.push(name); requests.push(name);
      if (name === "dashboard_open_quotes") await holdQuote;
      return { data: quoteAnswers[name], error: null };
    },
  };
  const functions = pageFunctions(dashboardPath, ["q", "qAll", "head", "qIn", "monthKey", "lastSixMonths", "loadAdminData"], {
    ...dates, ...tiles, ...analytics, ...metrics, ...jobFlow, ...jobStatus,
    fetchAll, supabase: client, awaitingApproval, missingDbObject, toPence,
    AlertCircle: "AlertCircle", databaseHas068: async () => true, DAY_MS: 86_400_000,
  });
  return { load: functions.loadAdminData, started, requests };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("dashboard result parity against the pinned candidate", () => {
  it.each([false, true])("keeps every returned figure for office=%s", async (office) => {
    const h = dashboardHarness();
    expect(await h.load(office)).toMatchSnapshot();
  });
  it("keeps a failed paid-invoice read blank without losing other figures", async () => {
    expect(await dashboardHarness("invoices").load(false)).toMatchSnapshot();
  });
});

describe("jobs row parity", () => {
  it("preserves the full job and legacy date/default mapping", () => {
    const { rowToJob } = pageFunctions(jobsPath, ["rowToJob"], { ...jobStatus, ...dates });
    expect([rowToJob(job), rowToJob({ id: "bare", is_internal: true }), rowToJob({ ...job, date_required: null, finished_at: null })]).toMatchSnapshot();
  });
});

describe("independent dashboard reads", () => {
  it("starts analytics and money while the quote wave is still pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = dashboardHarness(undefined, gate);
    const answer = h.load(false);
    try {
      expect(h.started).toContain("machines");
      expect(h.started).toContain("dashboard_money_owed");
      expect(h.started).toContain("overview_owed_snapshots");
    } finally { release(); }
    expect((await answer).moneyOwed).toBe(543.21);
  });

  it.each([[false, 34], [true, 19]] as const)("preserves request counts for the one-row fixture, office=%s", async (office, count) => {
    const h = dashboardHarness();
    await h.load(office);
    expect(h.requests).toHaveLength(count);
    if (office) {
      expect(h.started).not.toContain("dashboard_money_owed");
      expect(h.started).not.toContain("invoices");
      expect(h.started).not.toContain("machine_runs");
    }
  });
});

describe("jobs projection and refresh", () => {
  it("the named projection produces exactly the old mapped job, including offline/default cases", () => {
    const source = readFileSync(jobsPath, "utf8");
    const match = source.match(/from\("jobs"\)\.select\("([^"]+)"\)\.order\("created_at"/);
    expect(match).not.toBeNull();
    const columns = match![1].split(",").map((s) => s.trim());
    expect(columns).not.toContain("*");
    const { rowToJob } = pageFunctions(jobsPath, ["rowToJob"], { ...jobStatus, ...dates });
    for (const full of [job, { ...job, date_required: null, finished_at: null }, { id: "bare", is_internal: true }]) {
      const projected = Object.fromEntries(Object.entries(full).filter(([key]) => columns.includes(key)));
      expect(rowToJob(projected)).toEqual(rowToJob(full));
    }
  });

  it("polls every five minutes only while visible, keeps focus refresh, and removes timers/listeners", () => {
    const source = readFileSync(jobsPath, "utf8");
    const tree = ts.createSourceFile(jobsPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" && node.arguments[0]?.getText(tree).includes("window.setInterval")) effect = node.arguments[0];
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect(effect).toBeDefined();
    const listeners = new Map<string, () => void>();
    const add = vi.fn((name: string, handler: () => void) => { listeners.set(name, handler); });
    const remove = vi.fn((name: string) => { listeners.delete(name); });
    const document = { visibilityState: "visible", addEventListener: add, removeEventListener: remove };
    const window = { setInterval, clearInterval, addEventListener: add, removeEventListener: remove };
    const loadLive = vi.fn(), refreshPending = vi.fn();
    const code = ts.transpileModule(`const run = ${effect!.getText(tree)}; run`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const cleanup = runInNewContext(code, { window, document, loadLive, refreshPending })();
    vi.advanceTimersByTime(299_999);
    expect(loadLive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(loadLive).toHaveBeenCalledTimes(1);
    expect(loadLive).toHaveBeenLastCalledWith(false);
    document.visibilityState = "hidden";
    vi.advanceTimersByTime(600_000);
    listeners.get("focus")!();
    expect(loadLive).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(loadLive).toHaveBeenCalledTimes(2);
    expect(refreshPending).toHaveBeenCalledTimes(1);
    listeners.get("focus")!();
    expect(loadLive).toHaveBeenCalledTimes(3);
    cleanup();
    vi.advanceTimersByTime(600_000);
    expect(loadLive).toHaveBeenCalledTimes(3);
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
