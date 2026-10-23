import type { Phase } from "@/lib/archive";

/** Open / Done / Archived counts for a list: the numbers on the phase tabs. */
export function countPhases<T>(items: readonly T[], phaseFor: (item: T) => Phase): Record<Phase, number> {
  const counts: Record<Phase, number> = { open: 0, done: 0, archived: 0 };
  for (const item of items) counts[phaseFor(item)] += 1;
  return counts;
}

/** Every Sales Orders status except Converted: what the Open card's click shows (with the Open tab), so the card and the list agree. */
export const SALES_ORDER_OPEN_CARD_STATUSES = ["open", "confirmed", "in_production", "despatched", "closed"] as const;
export const SALES_ORDER_OPEN_CARD_NOTE = "Not finished and not yet converted to a job";

/**
 * Sales Orders cards. "Open" is the Open tab's count (everything not finished) without Converted orders: a converted order is
 * already a job, even when it still waits for its customer PO (that stays on the Open tab). The card's click shows the Open tab
 * filtered to SALES_ORDER_OPEN_CARD_STATUSES, so the number and the list match. Confirmed and Despatched count by the order's
 * status, as their filter chips do.
 */
export function salesOrderCardCounts<T extends { status: string }>(orders: readonly T[], phaseFor: (order: T) => Phase) {
  return {
    open: orders.filter((order) => phaseFor(order) === "open" && order.status !== "converted").length,
    confirmed: orders.filter((order) => order.status === "confirmed").length,
    despatched: orders.filter((order) => order.status === "despatched").length,
  };
}

/** Delivery notes already sent out and not yet signed. A note still "awaiting" (not sent out yet) is not one of them. */
export const AWAITING_SIGNATURE_STATUSES = ["despatched", "delivered"] as const;
/** Says what the card counts (Despatched: left us; Delivered: reached the customer); the status chip "Awaiting" is notes not despatched yet. */
export const AWAITING_SIGNATURE_LABEL = "Despatched or Delivered, Awaiting Signature";

export function countAwaitingSignature(notes: ReadonlyArray<{ status: string }>): number {
  return notes.filter((note) => (AWAITING_SIGNATURE_STATUSES as readonly string[]).includes(note.status)).length;
}
