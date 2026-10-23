import { describe, expect, it } from "vitest";

import { friendlyError } from "@/lib/friendly-error";
import { editBlockedReason } from "@/lib/sales-order-convert";

describe("friendlyError", () => {
  it("shows messages our own database checks wrote for people", () => {
    expect(friendlyError({ code: "PT409", message: "Quote QUO-1 was changed by someone else since you opened it. Reload it and make your changes again." }))
      .toMatch(/changed by someone else/);
    expect(friendlyError({ code: "42501", message: "Quote QUO-1 has been issued: copy it to make changes." })).toMatch(/copy it/);
    expect(friendlyError({ code: "22023", message: "Prices are in pounds and pence (at most 2 decimal places)" })).toMatch(/pounds and pence/);
  });

  it("never shows raw database text", () => {
    expect(friendlyError({ code: "42501", message: 'new row violates row-level security policy for table "quotes"' })).toBe("You don't have permission to do that.");
    expect(friendlyError({ code: "22023", message: 'invalid input syntax for type uuid: "x"' }, "Nope")).toBe("Nope");
    expect(friendlyError({ code: "23505", message: 'duplicate key value violates unique constraint "jobs_job_no_org_uniq"' })).toMatch(/already in use/);
  });

  it("names the booking identity refusal (064, 23514 + hint), not the quantities/prices message", () => {
    const booking = { code: "23514", hint: "booking_has_runs", message: "This booking has machine run history. Keep its job and machine, or create a separate booking." };
    expect(friendlyError(booking)).toBe(booking.message);
    expect(friendlyError({ code: "23514", hint: "run_booking_mismatch", message: "The booking must belong to this run's job, machine and company." })).toMatch(/job, machine and company/);
    // Raw text under the hint is never shown: the fixed text is.
    expect(friendlyError({ code: "23514", hint: "booking_has_runs", message: 'new row for relation "machine_bookings" violates check constraint' })).toMatch(/machine run history/);
    expect(friendlyError({ code: "23514", hint: "booking_has_runs" })).toMatch(/machine run history/);
    // Without a known hint 23514 stays the generic message; an unknown hint changes nothing.
    expect(friendlyError({ code: "23514", message: "x" })).toMatch(/quantities and prices/);
    expect(friendlyError({ code: "23514", hint: "toString", message: "x" })).toMatch(/quantities and prices/);
  });

  it("names the job flow refusals (081): the database's own sentence, or the fixed text when the message is raw", () => {
    const own = { code: "42501", hint: "not_independent", message: "You finished J-0001, so someone else must inspect it: the person who finished a job can't record its pass." };
    expect(friendlyError(own)).toBe(own.message);
    expect(friendlyError({ code: "42501", hint: "not_independent" })).toMatch(/can't record its pass/);
    expect(friendlyError({ code: "22023", hint: "job_not_released", message: 'new row for relation "delivery_notes" violates check constraint' })).toMatch(/isn't Complete yet/);
    for (const hint of ["criteria_required", "reopen_required", "reopen_not_allowed", "job_not_complete", "job_has_draft", "concession_admin_only", "record_immutable"]) {
      expect(friendlyError({ code: "22023", hint }), hint).not.toBe("Something went wrong. Try again.");
    }
  });

  it("shows 082's refusals (blocked supplier, used supplier or customer, traceable job) as written, or a fixed sentence", () => {
    const used = { code: "22023", hint: "supplier_in_use", message: "Steel Ltd is on 2 purchase orders and can't be deleted: those records keep it. To stop new orders, set it to Blocked." };
    expect(friendlyError(used)).toBe(used.message);
    const blocked = { code: "22023", hint: "supplier_blocked", message: "Steel Ltd is a blocked supplier, so this purchase order can't be issued. An admin can change its status on the Suppliers page." };
    expect(friendlyError(blocked)).toBe(blocked.message);
    const trace = { code: "22023", hint: "traceability_missing", message: "J-0001 is traceable: enter its heat/cast no. on the worksheet before it can pass." };
    expect(friendlyError(trace)).toBe(trace.message);
    // Too long, or raw text: the fixed sentence for that hint.
    expect(friendlyError({ ...used, message: `${"A".repeat(400)} is on 1 purchase order` })).toMatch(/This supplier is on purchase orders, jobs or stock items/);
    expect(friendlyError({ code: "22023", hint: "customer_in_use", message: 'update or delete on table "customers" violates foreign key constraint' })).toMatch(/This customer is on quotes/);
    expect(friendlyError({ code: "22023", hint: "traceability_missing" })).toMatch(/material cert no\. and heat\/cast no\./);
    // Decided Tue 20 Oct: a rename is refused like a delete; a new order names a listed supplier; only an admin sets a status.
    const renamed = { code: "22023", hint: "customer_in_use", message: "Acme is on 3 documents (quotes, RFQs, orders, jobs, delivery notes, invoices or credit notes) and can't be renamed: those records keep its name." };
    expect(friendlyError(renamed)).toBe(renamed.message);
    expect(friendlyError({ code: "22023", hint: "supplier_in_use" })).toMatch(/can't be renamed or deleted/);
    const unlisted = { code: "22023", hint: "supplier_not_listed", message: "Choose the supplier from the Suppliers list: Typed Ltd isn't on it. Add it on the Suppliers page first." };
    expect(friendlyError(unlisted)).toBe(unlisted.message);
    expect(friendlyError({ code: "22023", hint: "supplier_not_listed" })).toMatch(/Choose the supplier from the Suppliers list/);
    expect(friendlyError({ code: "42501", hint: "supplier_status_admin_only", message: "Only an admin can change a supplier's status." })).toBe("Only an admin can change a supplier's status.");
    expect(friendlyError({ code: "42501", hint: "supplier_status_admin_only", message: "permission denied for table suppliers" })).toBe("Only an admin can change a supplier's status.");
  });

  it("shows 083's refusals (not on the inspectors list, drawing revision needed) as written, or a fixed sentence", () => {
    const own = { code: "22023", hint: "drawing_revision_required", message: "J-0001 needs its drawing revision before it can be Complete: enter it under Drawing revision on the job." };
    expect(friendlyError(own)).toBe(own.message);
    expect(friendlyError({ code: "22023", hint: "drawing_revision_required", message: 'new row for relation "jobs" violates check constraint' })).toMatch(/needs its drawing revision/);
    expect(friendlyError({ code: "42501", hint: "not_authorised_inspector" })).toMatch(/authorised inspector/);
    expect(friendlyError({ code: "42501", hint: "drawing_revision_via_rpc" })).toMatch(/Drawing revision on the job/);
  });

  it("shows 088's refusal (a converted sales order's value and VAT) as the page's own sentence", () => {
    const own = { code: "42501", hint: "sales_order_converted", message: "Converted to J-0042: change the job, not the order." };
    expect(friendlyError(own)).toBe(editBlockedReason({ status: "converted", convertedJob: "J-0042" }));
    expect(friendlyError({ code: "42501", hint: "sales_order_converted", message: "permission denied for table sales_orders" })).toBe("Converted to a job: change the job, not the order.");
    expect(friendlyError({ code: "42501", hint: "sales_order_converted" })).toBe(editBlockedReason({ status: "converted" }));
  });

  it("shows 089's three invoice receipt refusals as written", () => {
    const newInvoice = { code: "42501", hint: "invoice_receipts_direct", message: "A new invoice starts with nothing paid or credited: payments are recorded with Record payment and credits applied with Apply credit, once it is issued." };
    expect(friendlyError(newInvoice)).toBe(newInvoice.message);
    const edited = { code: "42501", hint: "invoice_receipts_direct", message: "INV-0001: what is paid or credited changes only when a payment is recorded (Record payment) or a credit applied (Apply credit), not by editing it." };
    expect(friendlyError(edited)).toBe(edited.message);
    const mismatch = { code: "22023", hint: "invoice_receipts_mismatch", message: "This draft shows \u00a3120.00 paid and \u00a30.00 credited, but its recorded payments and credits come to \u00a30.00 and \u00a30.00: it was not issued. Ask for the invoice to be checked." };
    expect(friendlyError(mismatch)).toBe(mismatch.message);
  });

  it("shows 091's invoice issue refusal as written, and its own text when the message can't be shown", () => {
    const refused = { code: "42501", hint: "invoice_issue_direct", message: "This draft: a draft invoice is issued with Issue invoice, which gives it the next number. Its number and status are not set by editing it." };
    expect(friendlyError(refused)).toBe(refused.message);
    expect(friendlyError({ code: "42501", hint: "invoice_issue_direct", message: "permission denied for table invoices" })).toBe(
      "A draft invoice is issued with Issue invoice, which gives it the next number. Its number and status can't be set by editing it.");
    expect(friendlyError({ code: "42501", hint: "invoice_issue_direct" })).toMatch(/^A draft invoice is issued with Issue invoice/);
  });
});
