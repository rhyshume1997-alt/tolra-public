// The job, parts and supplier FACTS for a chase e-mail (migration 138). Pure. How an invoice reaches them on main: invoices.job_id is the
// invoice's job (jobs.job_no, stage, status, finished_at); a supplier purchase order is bought for that job when purchase_orders.job_id is
// the job, or purchase_orders.quote_id is the job's quote (124, lib/purchase-order-link.ts). A part is still AWAITED on an order that is
// not a draft, not received and not cancelled, with no received_at (the overview's "expected from suppliers" rule, lib/attention-load.ts).
// The expected date is the latest expected_delivery among the awaited orders that have one (all parts are in by then), as a UK date.
// How these facts READ in an e-mail is lib/chasing/templates.ts chaseJobVars (TODO-CHATGPT); no wording is written here.
import { fmtDate } from "@/lib/dates";
import { stageLabel } from "@/lib/job-flow";

export type ChaseJob = { job_no: string | null; stage: string | null; status: string | null; finished_at: string | null };
export type ChaseOrder = { status: string | null; received_at: string | null; expected_delivery: string | null };
/**
 * jobNumber / jobState: the invoice's job ("Complete", or its stage's name: Material, Setup, Machining, Inspection; "" when unknown).
 * partsAwaited: true while any linked order has parts to come; false when every linked order is received; null with no linked orders.
 * partsExpected: the latest expected date of the awaited orders (DD/MM/YYYY), null when none has one.
 */
export type ChaseJobFacts = { jobNumber: string; jobState: string; partsAwaited: boolean | null; partsExpected: string | null };

const CLOSED_ORDER = new Set(["draft", "received", "cancelled", "canceled"]);
const statusOf = (order: ChaseOrder) => String(order.status ?? "").trim().toLowerCase() || "draft";

/** True while an order still has parts to come. */
export function awaited(order: ChaseOrder): boolean {
  return !CLOSED_ORDER.has(statusOf(order)) && !order.received_at;
}

export function jobState(job: ChaseJob): string {
  if (job.finished_at || String(job.status ?? "").trim().toLowerCase() === "complete") return "Complete";
  const label = stageLabel(job.stage);
  return label === "—" ? "" : label;
}

/** The facts for an invoice's job and the orders bought for it; null when the invoice has no job (or the job has no number). */
export function chaseJobFacts(job: ChaseJob | null, orders: readonly ChaseOrder[] = []): ChaseJobFacts | null {
  const number = job?.job_no?.trim() ?? "";
  if (!job || !number) return null;
  const live = orders.filter((o) => !["draft", "cancelled", "canceled"].includes(statusOf(o)));
  const waiting = live.filter(awaited);
  const dates = waiting.map((o) => (o.expected_delivery ? String(o.expected_delivery).slice(0, 10) : "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return {
    jobNumber: number,
    jobState: jobState(job),
    partsAwaited: live.length ? waiting.length > 0 : null,
    partsExpected: dates.length ? fmtDate(dates[dates.length - 1]) : null,
  };
}
