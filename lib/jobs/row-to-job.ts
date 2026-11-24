// Boundary: pure mapping of a `jobs` row to the Job Board's WorkshopJob. Input: a database row. Output: WorkshopJob.
// Moved unchanged out of app/(dashboard)/jobs/page.tsx (docs/HARD_RULES.md rule 3). Must not read, write or fetch anything.
import { toDateInput } from "@/lib/dates";
import { jobStatus, requiredDate } from "@/lib/job-status";
import type { JobRecord } from "@/types";

export type WorkshopJob = JobRecord & {
  /** Who finished it (035): the person who may undo their own Finish while it awaits inspection (081). */
  finished_by?: string;
  started_at?: string;
  finished_at?: string;
  inspected_at?: string;
  inspected_by?: string;
  specification: string;
  drawings: string[];
  customer_po?: string;
  date_received?: string;
  date_required?: string;
  quote_ref?: string;
  quantity_required?: number | string;
  drawing_no?: string;
  /** Made for the company itself (migration 042): no customer needed, tagged "Internal" on the board. */
  is_internal?: boolean;
  /** The one job this job relates to (rework or tooling for job X), shown both ways on the board. */
  related_job_id?: string;
  /** The operator the job is assigned to (migration 044; informational, shown by display name). */
  assigned_to?: string;
  /** Made from a sales order (converted_from_sales_order_id): a delivery note can be made from it. */
  from_sales_order?: boolean;
};

export function rowToJob(row: Record<string, any>): WorkshopJob { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: row.id,
    job_no: row.job_no || row.reference || `JOB-${String(row.id).slice(0, 8)}`,
    customer: row.customer || row.customer_name || row.customer_id || (row.is_internal ? "Internal" : "Customer not linked"),
    description: row.description || "",
    stage: row.stage || "material",
    due_date: requiredDate(row),
    // The due-date state (lib/job-status): overdue is derived from the required date for unfinished jobs (finished_at null, as the
    // dashboard's Late and /jobs?filter=overdue count it); manual "at risk" is kept. Rework itself is a tag (the stage), not a status.
    status: jobStatus(row, toDateInput(new Date())),
    started_at: row.started_at || "",
    finished_at: row.finished_at || "",
    inspected_at: row.inspected_at || "",
    inspected_by: row.inspected_by || "",
    finished_by: row.finished_by || undefined,
    specification: row.specification || "No specification recorded.",
    drawings: Array.isArray(row.drawings) ? row.drawings : [],
    customer_po: row.customer_po || undefined,
    date_received: row.date_received || undefined,
    date_required: row.date_required || undefined,
    quote_ref: row.quote_ref || undefined,
    quantity_required: row.quantity_required ?? undefined,
    drawing_no: row.drawing_no || undefined,
    is_internal: Boolean(row.is_internal),
    related_job_id: row.related_job_id || undefined,
    assigned_to: row.assigned_to || undefined,
    from_sales_order: Boolean(row.converted_from_sales_order_id),
  };
}
