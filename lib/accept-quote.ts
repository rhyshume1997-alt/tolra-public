import { jobHref } from "@/lib/job-link";

/**
 * What accept_quote (migration 058) answers, and what staff are told about it. Accepting a quote makes its sales order, and its job
 * when the company's setting is automatic; a quote one order can't hold exactly is still accepted and its order is entered by hand.
 */
export type AcceptQuoteResult = {
  quote_id: string;
  quote_ref: string | null;
  /** The quote's version (068); only the latest version can be accepted. */
  version?: number;
  /** Lines on the order, and lines the customer's PO didn't cover (068: Confirm Accepted's tick boxes). */
  lines_ordered?: number;
  lines_declined?: number;
  /** True when this call accepted the quote; false when it was already accepted (nothing changed). */
  accepted: boolean;
  so_id: string | null;
  so_number: string | null;
  so_created: boolean;
  /** The order has a provisional SO-#### number: no customer PO yet. */
  provisional: boolean;
  job_id: string | null;
  job_no: string | null;
  job_created: boolean;
  auto_convert: boolean;
  /** "sales_order_by_hand" when no order could be made from the quote. */
  needs: string | null;
  reason: string | null;
  /** The order was made but its job wasn't (Convert to Job by hand). */
  job_reason: string | null;
};

export type AcceptOutcome = {
  tone: "success" | "info" | "warning";
  message: string;
  /** Where to go next: the job made, or the sales orders (to convert, or to enter the order by hand). */
  link: { label: string; href: string } | null;
};

/** Customer PO typed on the Confirm Accepted dialog (it starts as the quote's own, 123): trimmed; empty means none yet. */
export function customerPoInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The reference and customer PO for a sales order entered by hand. The PO is optional, as on Mark accepted: with none, customer_po
 * stays empty and the order takes a provisional SO-#### number (`next`), and the PO is added later on Sales Orders. With a PO the
 * order is referenced by it, as before.
 */
export async function manualOrderIdentity(customerPo: string, next: () => Promise<string>): Promise<{ soNumber: string; customerPo: string | null }> {
  const po = customerPoInput(customerPo);
  return po ? { soNumber: po, customerPo: po } : { soNumber: await next(), customerPo: null };
}

/** The due date typed on the Confirm Accepted dialog (YYYY-MM-DD from a date field): a real date, or null when none was given. */
export function deliveryDateInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? trimmed : null;
}

/**
 * A sales order still waiting for the customer's PO: made from an accepted quote with none (058), so it has no customer_po and a
 * provisional SO-#### reference. It stays Open on Sales Orders, even once converted, because "Add customer PO" is still to do there.
 * Older orders entered by hand that never stored a customer_po keep their own reference, so they are not counted as waiting.
 */
export function awaitsCustomerPo(order: { customerPo?: string | null; ref: string }): boolean {
  return !order.customerPo?.trim() && /^SO-\d{4,}$/.test(order.ref);
}

export function acceptOutcome(result: AcceptQuoteResult, ref = result.quote_ref ?? "The quote"): AcceptOutcome {
  const salesOrders = { label: "Open Sales Orders", href: "/sales-orders" };
  if (!result.so_id) {
    const why = result.reason ?? "No sales order could be made from it.";
    return {
      tone: "warning",
      message: `${ref} ${result.accepted ? "accepted" : "is accepted"}, but it needs a sales order by hand. ${why}`,
      link: salesOrders,
    };
  }
  const ordered = result.lines_ordered ?? 0;
  const declined = result.lines_declined ?? 0;
  const partial = result.accepted && ordered && declined ? ` for ${ordered} of ${ordered + declined} lines` : "";
  const order = `sales order ${result.so_number ?? ""}`.trim() + partial;
  const provisional = result.provisional ? " (no customer PO yet: add it on the quote when it arrives)" : "";
  if (!result.accepted) {
    const job = result.job_no ? ` and job ${result.job_no}` : "";
    return { tone: "info", message: `${ref} was already accepted: it has ${order}${job}. Nothing was changed.`, link: result.job_no ? jobLink(result, result.job_no) : salesOrders };
  }
  if (result.job_no) {
    return {
      tone: "success",
      message: `${ref} accepted. ${capitalise(order)} created${provisional} and job ${result.job_no} made, not started.`,
      link: jobLink(result, result.job_no),
    };
  }
  if (result.job_reason) {
    return { tone: "warning", message: `${ref} accepted. ${capitalise(order)} created${provisional}. ${result.job_reason}`, link: salesOrders };
  }
  return {
    tone: "success",
    message: `${ref} accepted. ${capitalise(order)} created${provisional}. Convert it to a job on Sales Orders when you're ready.`,
    link: salesOrders,
  };
}

const jobLink = (result: AcceptQuoteResult, jobNo: string) => ({ label: `Open job ${jobNo}`, href: jobHref({ id: result.job_id, job_no: jobNo }) });
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
