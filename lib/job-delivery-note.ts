/**
 * When a job can have a delivery note made from it: the rules the "From a job" picker on the Delivery Notes page already uses.
 * The job came from a sales order (that is what the lines are read from), and it is inspected, or it is in rework / inspection.
 * Since 081 a job that isn't Complete goes out only on an admin's early release (release_job_early), which the board can't see:
 * the button stays offered and the database decides (034/037/081), saying why when it refuses.
 */
export function jobReadyForDeliveryNote(job: { inspected_at?: string | null; stage?: string | null }): boolean {
  return Boolean(job.inspected_at) || job.stage === "rework" || job.stage === "inspection";
}

/** The Job Board's "Delivery note" button: office and admin only (workshop and viewer never see it), on a job made from a sales order that is ready. */
export function canOfferJobDeliveryNote(role: string | null | undefined, job: { from_sales_order?: boolean; inspected_at?: string | null; stage?: string | null }): boolean {
  return (role === "admin" || role === "office") && Boolean(job.from_sales_order) && jobReadyForDeliveryNote(job);
}
