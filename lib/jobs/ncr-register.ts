/**
 * The NCR register: one read-only list of the nonconformance records Tolra already keeps, for ISO 9001 clause 8.7. No new data is stored.
 * A record is one of: a rework (job_rework, 037; "Inspection fail" when raised by an inspection, else "Rework"), a concession
 * (job_inspections result 'concession', 034), a Problem (job_problems, 117), or a failed inspection that raised no rework.
 * A failed inspection is NOT listed twice: each fail raises its own rework row, which is the record. A replacement rework (follow_up_of)
 * is folded into its root, and a concession that closed a rework is not a separate record. A fail with no rework row (rows older than
 * 037, or inspection_id SET NULL) is shown as "Not linked", outside the open and closed counts.
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
/** The types of confirmed NCR (a rework, concession or problem). "Inspection fail (no rework)" is the legacy class, listed apart. */
export const NCR_CONFIRMED_TYPES = NCR_TYPES.filter((t) => t !== "Inspection fail (no rework)");
export type NcrRecordClass = "Confirmed NCR" | "Not linked";
export const NCR_CLOSED_ON_CONCESSION = "Closed on concession";
export type NcrStatusFilter = "open" | "closed" | "all";

export type RawRework = Pick<ReworkRecord, "id" | "job_id" | "inspection_id" | "status" | "reason" | "instructions" | "affects_all" | "quantity_affected" | "quantity_scrapped" | "quantity_remade" | "sales_order_line_id" | "raised_at" | "closed_at" | "closed_how" | "follow_up_of">;
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
  /** Open, for the Open tile and filter. False for closed and for "Not linked". */
  open: boolean;
  /** An inspection fail with no rework row: neither open nor closed, left out of the tiles' open/closed counts and of the day counts. */
  notLinked: boolean;
  recordClass: NcrRecordClass;
  /** The concession inspections that closed this record, each as "job|instant". Counted once across all records (summary). */
  concessionKeys: string[];
  closedAt: string | null;
  closedDate: string;
  closedHow: string;
  /** Calendar days from raised to closed (or to today while open). Null for "Not linked". */
  daysOpen: number | null;
  /** Follow-up (replacement) reworks folded into this record. */
  replacements: number;
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

/**
 * Group every rework under its ROOT, so one nonconformance is one record. A rework continues another in two ways:
 *  - a replacement rework (037 open_replacement_rework, ~1092-1100) names its parent in follow_up_of;
 *  - a repeated failure (037 fail_job_inspection, ~488-498): in ONE transaction the finished rework(s) the new failure covers are closed
 *    'superseded' (closed_at = now) and new reworks are inserted with raised_at = the same now. So R2 continues R1 when: same job,
 *    R1.closed_how = 'superseded', R1.closed_at = R2.raised_at exactly, and the lines match (R1 has no line, or R2.affects_all, or
 *    the same sales_order_line_id). One R1 may be continued by several R2 (a line split): all join R1's chain. If one R2 could continue
 *    several R1, the one with the same line wins, else the earliest raised (then id). A new failure that superseded nothing, or only
 *    a rework on another line, matches nothing and is a SEPARATE nonconformance.
 * A missing parent makes the node its own root; a cycle (cannot happen) resolves to its earliest-raised member.
 */
function continuationParent(r: RawRework, all: RawRework[]): RawRework | undefined {
  const at = Date.parse(r.raised_at);
  const fits = all.filter((c) => c.id !== r.id && c.job_id === r.job_id && c.closed_how === "superseded" && c.closed_at && Date.parse(c.closed_at) === at
    && (c.sales_order_line_id === null || r.affects_all || c.sales_order_line_id === r.sales_order_line_id));
  const pool = fits.filter((c) => c.sales_order_line_id !== null && c.sales_order_line_id === r.sales_order_line_id);
  return (pool.length ? pool : fits).reduce<RawRework | undefined>((a, c) => (!a || c.raised_at < a.raised_at || (c.raised_at === a.raised_at && c.id < a.id) ? c : a), undefined);
}

export function groupReworkChains(reworks: RawRework[]): Map<string, RawRework[]> {
  const byId = new Map(reworks.map((r) => [r.id, r]));
  const parentOf = new Map<string, RawRework | undefined>(reworks.map((r) => [r.id, (r.follow_up_of ? byId.get(r.follow_up_of) : undefined) ?? (r.follow_up_of ? undefined : continuationParent(r, reworks))]));
  const rootOf = (start: RawRework): RawRework => {
    const path: RawRework[] = [];
    let cur: RawRework = start;
    for (;;) {
      const at = path.indexOf(cur);
      if (at >= 0) {
        return path.slice(at).reduce((a, b) => (b.raised_at < a.raised_at || (b.raised_at === a.raised_at && b.id < a.id) ? b : a));
      }
      path.push(cur);
      const parent = parentOf.get(cur.id);
      if (!parent) return cur;
      cur = parent;
    }
  };
  const chains = new Map<string, RawRework[]>();
  for (const r of reworks) {
    const root = rootOf(r);
    chains.set(root.id, [...(chains.get(root.id) ?? []), r]);
  }
  return chains;
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

  type Draft = Omit<NcrRow, "record" | "raisedDate" | "closedDate" | "daysOpen" | "jobNo" | "customer" | "notLinked" | "replacements" | "recordClass" | "concessionKeys"> & { jobId: string; notLinked?: boolean; replacements?: number; concessionKeys?: string[] };
  const make = (r: Draft): NcrRow => {
    const { jobId, notLinked = false, replacements = 0, concessionKeys = [], ...rest } = r;
    const { jobNo, customer } = jobOf(jobId);
    const raisedDate = toDateInput(rest.raisedAt);
    const closedDate = rest.closedAt ? toDateInput(rest.closedAt) : "";
    const daysOpen = notLinked ? null : daysBetween(raisedDate, rest.open ? today : closedDate || raisedDate);
    return { ...rest, jobNo, customer, notLinked, replacements, concessionKeys, recordClass: notLinked ? "Not linked" as const : "Confirmed NCR" as const, record: `${jobNo || "No job"} ${rest.type} ${raisedDate}`, raisedDate, closedDate, daysOpen };
  };

  const rows: NcrRow[] = [];
  const reworkedInspections = new Set<string>();
  // 037 record_job_inspection (lines 624-631): a concession inserts its job_inspections row and, in the same transaction, closes the
  // job's live reworks with closed_how 'concession' and closed_at = the same now() as inspected_at. No column links them, so the match
  // is job + that exact instant. Such a concession is the closing of a rework, not a separate nonconformance.
  const closedByConcession = new Set(src.reworks.filter((r) => r.closed_how === "concession" && r.closed_at).map((r) => `${r.job_id}|${Date.parse(r.closed_at!)}`));

  for (const [rootId, chain] of groupReworkChains(src.reworks)) {
    const r = chain.find((c) => c.id === rootId)!;
    for (const c of chain) if (c.inspection_id) reworkedInspections.add(c.inspection_id);
    // Open until the final closing is an acceptance: a finished rework awaits reinspection (Open), and a chain whose last closing is
    // 'superseded' (failed again) is Open too. Closed only when every link is closed and the last closing(s) passed or conceded.
    const closers = chain.filter((c) => c.status === "closed" && c.closed_at);
    const latest = closers.reduce((t, c) => Math.max(t, Date.parse(c.closed_at!)), -Infinity);
    const finalClosers = closers.filter((c) => Date.parse(c.closed_at!) === latest);
    const accepted = (c: RawRework) => c.closed_how === "passed" || c.closed_how === "concession";
    const open = chain.some((c) => c.status !== "closed") || !finalClosers.length || !finalClosers.every(accepted);
    const last = finalClosers.find((c) => c.closed_how === "concession") ?? finalClosers[0] ?? null;
    const concessionKeys = [...new Set(closers.filter((c) => c.closed_how === "concession").map((c) => `${c.job_id}|${Date.parse(c.closed_at!)}`))];
    const hours = chain.reduce((t, c) => t + (hoursBy.get(c.id) ?? 0), 0);
    const costPence = chain.reduce((t, c) => t + (costPenceBy.get(c.id) ?? 0), 0);
    rows.push(make({
      key: `rework:${r.id}`, jobId: r.job_id, type: r.inspection_id ? "Inspection fail" : "Rework", raisedAt: r.raised_at,
      reason: r.reason, action: r.instructions, quantityAffected: r.quantity_affected, affectsAll: r.affects_all,
      // As 037 job_rework_summary (line 253): scrapped counts roots only (a follow-up's scrapped is the root's owed quantity carried
      // over); replacements actually made are summed over the whole chain.
      scrapped: r.quantity_scrapped, remade: chain.reduce((t, c) => t + c.quantity_remade, 0),
      statusText: open ? (chain.find((c) => c.status !== "closed") ? REWORK_STATUS_LABELS[chain.find((c) => c.status !== "closed")!.status] : CLOSED_LABELS.superseded) : "Closed", open,
      closedAt: open ? null : last?.closed_at ?? null, closedHow: open ? "" : last?.closed_how === "concession" ? NCR_CLOSED_ON_CONCESSION : last?.closed_how ? CLOSED_LABELS[last.closed_how] ?? last.closed_how : "",
      concessionKeys,
      hours: Math.round(hours * 100) / 100, materialCost: costPence / 100, replacements: chain.length - 1, // follow-up and repeat-failure reworks folded in
    }));
  }

  for (const i of src.inspections) {
    if (i.result === "concession") {
      if (closedByConcession.has(`${i.job_id}|${Date.parse(i.inspected_at)}`)) continue;
      rows.push(make({
        key: `concession:${i.id}`, jobId: i.job_id, type: "Concession", raisedAt: i.inspected_at,
        reason: i.concession_reason ?? "", action: i.inspector_name ? `Concession recorded by ${i.inspector_name}` : "Concession recorded",
        quantityAffected: null, affectsAll: false, scrapped: null, remade: null, statusText: "Closed", open: false,
        closedAt: i.inspected_at, closedHow: NCR_CLOSED_ON_CONCESSION, hours: null, materialCost: null,
        concessionKeys: [`${i.job_id}|${Date.parse(i.inspected_at)}`],
      }));
    } else if (i.result === "fail" && !reworkedInspections.has(i.id)) {
      // Every fail raises a rework (037 fail_job_inspection), so this only arises for rows older than 037 or where the rework's
      // inspection_id was SET NULL. It is shown on its own status ("Not linked"), outside the open/closed counts and day counts.
      rows.push(make({
        key: `fail:${i.id}`, jobId: i.job_id, type: "Inspection fail (no rework)", raisedAt: i.inspected_at,
        reason: i.measured_notes ?? "", action: "", quantityAffected: null, affectsAll: false, scrapped: null, remade: null,
        statusText: "Not linked", open: false, notLinked: true, closedAt: null, closedHow: "", hours: null, materialCost: null,
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
    && (f.status === "all" || (!r.notLinked && (f.status === "open") === r.open)));
}

/** Confirmed-NCR totals only: "Not linked" legacy rows are counted apart (notLinked) and in none of the other figures. */
export type NcrSummary = {
  total: number; open: number; closed: number; notLinked: number; byType: Record<NcrType, number>;
  /** Concession inspections (initial and reinspection), each counted once even if it closed several reworks. */
  concessions: number;
  quantityScrapped: number;
  /** Mean calendar days from raised to closed, closed records only; null when none are closed. One decimal place. */
  averageDaysToClose: number | null;
  hours: number; materialCost: number;
};

export function splitByClass(rows: NcrRow[]): { confirmed: NcrRow[]; notLinked: NcrRow[] } {
  return { confirmed: rows.filter((r) => !r.notLinked), notLinked: rows.filter((r) => r.notLinked) };
}

export function summariseNcrRows(rows: NcrRow[]): NcrSummary {
  const byType = Object.fromEntries(NCR_TYPES.map((t) => [t, 0])) as Record<NcrType, number>;
  const { confirmed, notLinked } = splitByClass(rows);
  const concessions = new Set<string>();
  let open = 0, scrapped = 0, hours = 0, costPence = 0, closedDays = 0, closed = 0;
  for (const r of confirmed) {
    byType[r.type] += 1;
    r.concessionKeys.forEach((k) => concessions.add(k));
    scrapped += r.scrapped ?? 0;
    hours += r.hours ?? 0;
    costPence += toPence(r.materialCost ?? 0);
    if (r.open) open += 1;
    else { closed += 1; closedDays += r.daysOpen ?? 0; }
  }
  return {
    total: confirmed.length, open, closed, notLinked: notLinked.length, byType, concessions: concessions.size, quantityScrapped: scrapped,
    averageDaysToClose: closed ? Math.round((closedDays / closed) * 10) / 10 : null,
    hours: Math.round(hours * 100) / 100, materialCost: costPence / 100,
  };
}

/** CSV columns. Text is formula-guarded and quoted by lib/spreadsheet toCsv; dates are ISO. Money is GBP pounds. */
export const NCR_CSV_COLUMNS: SheetColumn<NcrRow>[] = [
  { header: "Record class", type: "text", value: (r) => r.recordClass },
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
  { header: "Replacements", type: "number", value: (r) => r.replacements },
  { header: "Rework hours", type: "number", value: (r) => r.hours },
  { header: "Material cost (GBP)", type: "money", value: (r) => r.materialCost },
];

export function ncrCsv(rows: NcrRow[]): string {
  return toCsv(NCR_CSV_COLUMNS, rows);
}
