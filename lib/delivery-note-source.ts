/** Where a new delivery note comes from (migration 034): a sales order, a job, or by hand with no order behind it. */
export type NoteSource = "order" | "job" | "manual";

/**
 * Which choice the New Delivery Note form opens on. Despatch goes by the job, so the workshop always starts there, and admin and
 * office do too once there is a job made from an order to pick; with none they start on the sales order. The other choices stay
 * one click away on the form.
 */
export function defaultNoteSource(activeRole: string | null | undefined, jobsExist: boolean): NoteSource {
  if (activeRole === "workshop") return "job";
  if ((activeRole === "admin" || activeRole === "office") && jobsExist) return "job";
  return "order";
}
