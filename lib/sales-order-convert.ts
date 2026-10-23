/**
 * Whether a sales order can still be made into a job. An order that already has a job (its converted_to_job_id is set, shown on
 * the page as convertedJob) or whose status is "converted" is done: the page hides Convert to Job for it, so a second job is never
 * offered. Pure, so the rule is tested once.
 */
export type ConvertibleOrder = { status?: string | null; convertedJob?: string | null };

export function isConverted(order: ConvertibleOrder): boolean {
  return Boolean(order.convertedJob) || order.status === "converted";
}

/**
 * Why a sales order can't be edited, or null when it can. A converted order's value and VAT went to its job (convert_sales_order), so
 * the order is not changed afterwards: the page disables Edit with this reason and saveEdit refuses before writing. The database
 * refuses a change of the value or VAT too (migration 088, hint sales_order_converted, the same sentence).
 */
export function editBlockedReason(order: ConvertibleOrder): string | null {
  if (!isConverted(order)) return null;
  const job = order.convertedJob && order.convertedJob !== "Linked" ? order.convertedJob : "a job";
  return `Converted to ${job}: change the job, not the order.`;
}

/** The orders a "Convert Selected to Jobs" press should act on: the ones with no job yet. */
export function ordersToConvert<T extends ConvertibleOrder>(orders: readonly T[]): T[] {
  return orders.filter((order) => !isConverted(order));
}

/**
 * When Despatch is offered on a sales order (one rule, used by the row, detail and toolbar buttons). Despatch is a plain status
 * write ("despatched"): on a converted order it would replace "converted" (the job is its next step), and on a despatched or
 * closed order it does nothing useful. So it is only for an order still to be worked on: no job yet, and status open, confirmed
 * or in production. A missing status counts as open.
 */
export const DESPATCHABLE_STATUSES = ["open", "confirmed", "in_production"] as const;

export function canDespatch(order: ConvertibleOrder): boolean {
  return !isConverted(order) && (DESPATCHABLE_STATUSES as readonly string[]).includes(order.status ?? "open");
}

/** The orders a "Despatch Selected" press should act on: the ones canDespatch allows. */
export function ordersToDespatch<T extends ConvertibleOrder>(orders: readonly T[]): T[] {
  return orders.filter(canDespatch);
}
