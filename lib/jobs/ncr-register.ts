/**
 * The NCR register: one read-only list of the nonconformance records Tolra already keeps, for ISO 9001 clause 8.7. No new data is stored.
 * A record is one of: a rework (job_rework, 037; "Inspection fail" when raised by an inspection, else "Rework"), a concession
 * (job_inspections result 'concession', 034), a Problem (job_problems, 117), or a failed inspection that raised no rework.
 * A failed inspection is NOT listed twice: each fail raises its own rework row, which is the record.
 *
 * Inputs: raw rows as the loader (load-ncr-register.ts) reads them, a date range, filters and "today". Outputs: register rows, the
 * summary tiles and the CSV text. There are no official NCR numbers: a row is identified by its job number, type and date ("Record").
 * Must not change: the open/closed rules per type, the inclusive local-date range, or the CSV formula guard (lib/spreadsheet toCsv).
 *
 * Pure (no React, no I/O).
 */
import { toDateInput } from "@/lib/dates";
import { PROBLEM_REASONS } from "@/lib/job-problems";
import { toPence } from "@/lib/money";
import { CLOSED_LABELS, REWORK_STATUS_LABELS, type ReworkRecord } from "@/lib/rework";
import { toCsv, type SheetColumn } from "@/lib/spreadsheet";

export const NCR_TYPES = ["Rework", "Inspection fail", "Inspection fail (no rework)", "Concession", "Problem"] as const;
export type NcrType = (typeof NCR_TYPES)[number];
export type NcrStatusFilter = "open" | "closed" | "all";

export type RawRework = Pick<ReworkRecord, "id" | "job_id" | "inspection_id" | "status" | "reason" | "instructions" | "affects_all" | "quantity_affected" | "quantity_scrapped" | "quantity_remade" | "raised_at" | "closed_at" | "closed_how" | "follow_up_of">;
export type RawInspection = { id: string; job_id: string; result: string; concession_reason: string | null; measured_notes: string | null; inspector_name: string | null; inspected_at: string };
export type RawProblem = { id: string; job_id: string; reason: string; note: string | null; status: string; reported_at: string; resolved_at: string | null; resolution_note: string | null };
export type RawEntry = { id: string; rework_id: string; kind: string; hours: number | string | null };
export type RawEntryValue = { entry_id: string; material_cost: number | string | null };
export type RawJob = { id: string; job_no: string | null; customer: string | null };

export type NcrSources = {
  reworks: RawRework[];
  inspections: RawInspection[];
  problems: RawProblem[];
  entries: RawEntry[];
  entryValues: RawEntryValue[];
  jobs: RawJob[];
};

export type NcrRow = {
  key: string;
  jobNo: string;
  customer: string;
  type: NcrType;
  /** "J-0101 Rework 2026-10-05": job number, type and date. Not an official NCR number. */
  record: string;
  raisedAt: string;
  raisedDate: string;
  reason: string;
  action: string;
  quantityAffected: number | null;
  affectsAll: boolean;
  scrapped: number | null;
  remade: number | null;
  statusText: string;
  open: boolean;
  closedAt: string | null;
  closedDate: string;
  closedHow: string;
  daysOpen: number;
  hours: number | null;
  materialCost: number | null;
};

const num = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));

/** Whole calendar days from one local date to another (never negative). Dates are YYYY-MM-DD. */
export function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function reasonText(reason: string): string {
  return PROBLEM_REASONS.find((r) => r.value === reason)?.label ?? "Other";
}

/** Build every register row from the raw records. Newest raised first. */
export function buildNcrRows(src: NcrSources, now: Date | string = new Date()): NcrRow[] {
  const today = toDateInput(now);
  const jobs = new Map(src.jobs.map((j) => [j.id, j]));
  const jobOf = (id: string) => ({ jobNo: jobs.get(id)?.job_no ?? "", customer: jobs.get(id)?.customer ?? "" });

  const hoursBy = new Map<string, number>();
  const costPenceBy = new Map<string, number>();
  const entryRework = new Map<string, string>();
  for (const e of src.entries) {
    entryRework.set(e.id, e.rework_id);
    if (e.kind === "hours") hoursBy.set(e.rework_id, (hoursBy.get(e.rework_id) ?? 0) + num(e.hours));
  }
  for (const v of src.entryValues) {
    const reworkId = entryRework.get(v.entry_id);
    if (reworkId) costPenceBy.set(reworkId, (costPenceBy.get(reworkId) ?? 0) + toPence(num(v.material_cost)));
  }

  const make = (r: Omit<NcrRow, "record" | "raisedDate" | "closedDate" | "daysOpen" | "jobNo" | "customer"> & { jobId: string }): NcrRow => {
    const { jobId, ...rest } = r;
    const { jobNo, customer } = jobOf(jobId);
    const raisedDate = toDateInput(rest.raisedAt);
    const closedDate = rest.closedAt ? toDateInput(rest.closedAt) : "";
    const daysOpen = daysBetween(raisedDate, rest.open ? today : closedDate || raisedDate);
    return { ...rest, jobNo, customer, record: `${jobNo || "No job"} ${rest.type} ${raisedDate}`, raisedDate, closedDate, daysOpen };
  };

  const rows: NcrRow[] = [];
  const reworkedInspections = new Set<string>();

  for (const r of src.reworks) {
    if (r.inspection_id) reworkedInspections.add(r.inspection_id);
    const open = r.status !== "closed";
    rows.push(make({
      key: `rework:${r.id}`, jobId: r.job_id, type: r.inspection_id ? "Inspection fail" : "Rework", raisedAt: r.raised_at,
      reason: r.reason, action: r.instructions, quantityAffected: r.quantity_affected, affectsAll: r.affects_all,
      scrapped: r.quantity_scrapped, remade: r.quantity_remade,
      statusText: open ? REWORK_STATUS_LABELS[r.status] ?? r.status : "Closed", open,
      closedAt: open ? null : r.closed_at, closedHow: !open && r.closed_how ? CLOSED_LABELS[r.closed_how] ?? r.closed_how : "",
      hours: hoursBy.has(r.id) ? Math.round((hoursBy.get(r.id) ?? 0) * 100) / 100 : 0,
      materialCost: (costPenceBy.get(r.id) ?? 0) / 100,
    }));
  }

  for (const i of src.inspections) {
    if (i.result === "concession") {
      rows.push(make({
        key: `concession:${i.id}`, jobId: i.job_id, type: "Concession", raisedAt: i.inspected_at,
        reason: i.concession_reason ?? "", action: i.inspector_name ? `Concession recorded by ${i.inspector_name}` : "Concession recorded",
        quantityAffected: null, affectsAll: false, scrapped: null, remade: null, statusText: "Closed", open: false,
        closedAt: i.inspected_at, closedHow: "Accepted on a concession", hours: null, materialCost: null,
      }));
    } else if (i.result === "fail" && !reworkedInspections.has(i.id)) {
      rows.push(make({
        key: `fail:${i.id}`, jobId: i.job_id, type: "Inspection fail (no rework)", raisedAt: i.inspected_at,
        reason: i.measured_notes ?? "", action: "", quantityAffected: null, affectsAll: false, scrapped: null, remade: null,
        statusText: "Open", open: true, closedAt: null, closedHow: "", hours: null, materialCost: null,
      }));
    }
  }

  for (const p of src.problems) {
    const open = p.status !== "resolved";
    rows.push(make({
      key: `problem:${p.id}`, jobId: p.job_id, type: "Problem", raisedAt: p.reported_at,
      reason: p.note ? `${reasonText(p.reason)}: ${p.note}` : reasonText(p.reason), action: p.resolution_note ?? "",
      quantityAffected: null, affectsAll: false, scrapped: null, remade: null,
      statusText: open ? "Open" : "Resolved", open, closedAt: open ? null : p.resolved_at, closedHow: open ? "" : "Resolved",
      hours: null, materialCost: null,
    }));
  }

  return rows.sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : a.raisedAt > b.raisedAt ? -1 : a.key < b.key ? -1 : 1));
}

export type NcrFilters = { from: string; to: string; type: "all" | NcrType; status: NcrStatusFilter };

/** Default range: the last 90 days up to and including today (local dates). */
export function defaultRange(now: Date | string = new Date()): { from: string; to: string } {
  const to = toDateInput(now);
  const start = new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to };
}

/** Filter by raised date (inclusive both ends, local dates), type and status. A blank bound is open-ended. */
export function filterNcrRows(rows: NcrRow[], f: NcrFilters): NcrRow[] {
  return rows.filter((r) =>
    (!f.from || r.raisedDate >= f.from) && (!f.to || r.raisedDate <= f.to)
    && (f.type === "all" || r.type === f.type)
    && (f.status === "all" || (f.status === "open") === r.open));
}

export type NcrSummary = {
  total: number; open: number; closed: number; byType: Record<NcrType, number>;
  quantityScrapped: number;
  /** Mean calendar days from raised to closed, closed records only; null when none are closed. One decimal place. */
  averageDaysToClose: number | null;
  hours: number; materialCost: number;
};

export function summariseNcrRows(rows: NcrRow[]): NcrSummary {
  const byType = Object.fromEntries(NCR_TYPES.map((t) => [t, 0])) as Record<NcrType, number>;
  let open = 0, scrapped = 0, hours = 0, costPence = 0, closedDays = 0, closed = 0;
  for (const r of rows) {
    byType[r.type] += 1;
    scrapped += r.scrapped ?? 0;
    hours += r.hours ?? 0;
    costPence += toPence(r.materialCost ?? 0);
    if (r.open) open += 1; else { closed += 1; closedDays += r.daysOpen; }
  }
  return {
    total: rows.length, open, closed, byType, quantityScrapped: scrapped,
    averageDaysToClose: closed ? Math.round((closedDays / closed) * 10) / 10 : null,
    hours: Math.round(hours * 100) / 100, materialCost: costPence / 100,
  };
}

/** CSV columns. Text is formula-guarded and quoted by lib/spreadsheet toCsv; dates are ISO. Money is GBP pounds. */
export const NCR_CSV_COLUMNS: SheetColumn<NcrRow>[] = [
  { header: "Record", type: "text", value: (r) => r.record },
  { header: "Job", type: "text", value: (r) => r.jobNo },
  { header: "Customer", type: "text", value: (r) => r.customer },
  { header: "Type", type: "text", value: (r) => r.type },
  { header: "Raised", type: "date", value: (r) => r.raisedDate },
  { header: "Reason / description", type: "text", value: (r) => r.reason },
  { header: "Action / disposition", type: "text", value: (r) => r.action },
  { header: "Qty affected", type: "text", value: (r) => (r.affectsAll ? "All" : r.quantityAffected === null ? "" : String(r.quantityAffected)) },
  { header: "Scrapped", type: "number", value: (r) => r.scrapped },
  { header: "Remade", type: "number", value: (r) => r.remade },
  { header: "Status", type: "text", value: (r) => r.statusText },
  { header: "Closed", type: "date", value: (r) => r.closedDate },
  { header: "Closed how", type: "text", value: (r) => r.closedHow },
  { header: "Days open", type: "number", value: (r) => r.daysOpen },
  { header: "Rework hours", type: "number", value: (r) => r.hours },
  { header: "Material cost (GBP)", type: "money", value: (r) => r.materialCost },
];

export function ncrCsv(rows: NcrRow[]): string {
  return toCsv(NCR_CSV_COLUMNS, rows);
}
