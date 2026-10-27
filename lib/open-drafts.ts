import { isVoid } from "@/lib/invoice-void";
import { invoiceStatus } from "@/lib/receivables";

/**
 * THE rule for "an open draft invoice" (the one definition behind "Drafts waiting to issue" on Invoicing and the dashboard's draft
 * invoices item; every count of open drafts must call this, never re-derive it). An invoice is an open draft only if it is
 * active: still a draft (a missing status is a draft), so unissued; not void (or cancelled); and not archived by hand
 * (record_archive_state). Issued, sent, paid, void and archived invoices are never counted. The age cut-off
 * (DRAFT_INVOICE_DAYS) is a narrowing of this set for the dashboard, not a different definition.
 */
export function isOpenDraft(rawStatus: string | null | undefined, archived: boolean): boolean {
  return invoiceStatus(rawStatus) === "draft" && !isVoid(rawStatus) && !archived;
}
