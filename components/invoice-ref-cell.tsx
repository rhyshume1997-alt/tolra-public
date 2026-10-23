import { shownInvoiceRef } from "@/lib/invoice-ref";

/**
 * What the Invoice column of the Invoices list shows, the same in the table, list and card views (they share this cell): the
 * number, or "Draft, no number yet" for a draft; and, for a draft the system made from a delivery note, "Auto-drafted from DLN-0001"
 * on its own secondary line, never run on to the number or the word.
 */
export function InvoiceRefCell({ invoice, autoDraftedFrom, jobStage }: { invoice: { reference: string; unnumbered?: boolean }; autoDraftedFrom?: string | null; jobStage?: string | null }) {
  return (
    <>
      <span data-testid="invoice-ref">{shownInvoiceRef(invoice)}</span>
      {/* 081: a draft made for a job reads "Draft, awaiting inspection" until the job is Complete, then "Ready to issue". */}
      {jobStage ? <span data-testid="draft-job-stage" className="block font-sans text-xs font-normal text-slate-600 dark:text-slate-300">{jobStage}</span> : null}
      {autoDraftedFrom ? <span data-testid="auto-drafted" className="block font-sans text-xs font-normal text-slate-600 dark:text-slate-300">Auto-drafted from {autoDraftedFrom}</span> : null}
    </>
  );
}
