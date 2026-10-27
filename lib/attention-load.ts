/**
 * Reads the rows behind the dashboard's "Needs attention" list (rules: lib/attention-items). It uses the signed-in person's own
 * client, so row level security scopes every read to their company and role; nothing here widens access. Each read fails on its
 * own: a failed read gives null for that input, which shows "couldn't load" for those sections only, never a blank dashboard.
 * Only the tables the role's rules need are read (workshop and viewer never touch quotes, invoices, purchase orders).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { type AttentionInput, type AttentionRole, buildAttention, rulesForRole } from "@/lib/attention-items";
import { toDateInput } from "@/lib/dates";
import { missingDbObject } from "@/lib/db-features";
import { fetchAll } from "@/lib/fetch-all";
import { invoiceStatus } from "@/lib/receivables";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = (from: number, to: number) => PromiseLike<{ data: any; error: unknown }>;

/** All rows of one read, or null when it failed or was cut short (a partial list must not pass as complete). */
async function rowsOf(page: Page): Promise<Record<string, unknown>[] | null> {
  try {
    const { rows, truncated } = await fetchAll(page);
    return truncated ? null : rows;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** Drafts archived by hand (record_archive_state) are not waiting to issue: Invoicing's drafts line leaves them out, so the dashboard does too. Other invoices are untouched. */
export function withoutArchivedDrafts(rows: Record<string, unknown>[], archivedIds: ReadonlySet<string>): Record<string, unknown>[] {
  return rows.filter((row) => !(invoiceStatus(row.status as string | null) === "draft" && archivedIds.has(String(row.id))));
}

/** 099's Complete jobs still to despatch or invoice; [] before 099 (the function is missing), null when the read failed. */
export async function unbilledJobsOf(db: SupabaseClient): Promise<Record<string, unknown>[] | null> {
  try {
    const { data, error } = await db.rpc("jobs_awaiting_despatch_or_invoice");
    if (error) {
      if (missingDbObject(error)) return [];
      console.error(error);
      return null;
    }
    return (data ?? []) as Record<string, unknown>[];
  } catch (err) {
    console.error(err);
    return null;
  }
}

export async function loadAttention(db: SupabaseClient, role: AttentionRole) {
  const wanted = new Set(rulesForRole(role).map((rule) => rule.id));
  const need = (...ids: Array<ReturnType<typeof rulesForRole>[number]["id"]>) => ids.some((id) => wanted.has(id));
  // invoices.status is nullable and a missing status is a draft (lib/receivables invoiceStatus): .neq("status","paid") alone would drop
  // those rows in SQL (NULL <> 'paid' is not true), so a null-status draft never reached the dashboard.
  const none = Promise.resolve([] as Record<string, unknown>[] | null);

  const [quotes, rfqs, quoted, purchaseOrders, lateJobs, finishedJobs, invoices, deliveryNotes, unbilledJobs] = await Promise.all([
    need("quotes-expired", "quotes-no-decision")
      ? rowsOf((from, to) => db.from("quotes").select("id, quote_ref, customer, status, valid_until, sent_at").in("status", ["draft", "sent"]).order("id").range(from, to))
      : none,
    need("rfqs-clarification")
      ? rowsOf((from, to) => db.from("rfqs").select("id, customer, description, status, created_at").eq("status", "clarification").order("id").range(from, to))
      : none,
    need("rfqs-clarification")
      ? rowsOf((from, to) => db.from("quotes").select("id, rfq_id").not("rfq_id", "is", null).order("id").range(from, to))
      : none,
    need("pos-late")
      ? rowsOf((from, to) => db.from("purchase_orders").select("id, po_ref, po_number, supplier, status, expected_delivery, received_at").not("expected_delivery", "is", null).not("status", "in", "(draft,received,cancelled)").is("received_at", null).order("id").range(from, to))
      : none,
    need("jobs-late")
      ? rowsOf((from, to) => db.from("jobs").select("id, job_no, customer, date_required, due_date, finished_at").is("finished_at", null).order("id").range(from, to))
      : none,
    need("jobs-inspection")
      ? rowsOf((from, to) => db.from("jobs").select("id, job_no, customer, finished_at, inspected_at, stage").not("finished_at", "is", null).is("inspected_at", null).order("id").range(from, to))
      : none,
    need("invoices-overdue", "invoices-draft")
      ? rowsOf((from, to) => db.from("invoices").select("id, invoice_ref, customer, total, status, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified, created_at").or("status.is.null,status.neq.paid").order("id").range(from, to))
      : none,
    need("delivery-awaiting", "delivery-uninvoiced")
      ? rowsOf((from, to) => db.from("delivery_notes").select("id, dn_number, customer, status, invoice_id, delivery_date, created_at, updated_at").in("status", wanted.has("delivery-uninvoiced") ? ["awaiting", "despatched", "delivered", "signed"] : ["awaiting"]).order("id").range(from, to))
      : none,
    need("jobs-unbilled") ? unbilledJobsOf(db) : none,
  ]);
  // A failed archive read gives null invoices ("couldn't load"), never a draft list that might include archived ones.
  const archivedInvoices = need("invoices-draft") && invoices
    ? await rowsOf((from, to) => db.from("record_archive_state").select("record_id").eq("record_table", "invoices").eq("state", "archived").order("record_id").range(from, to))
    : null;
  const invoiceRows = !invoices ? null : need("invoices-draft") ? (archivedInvoices ? withoutArchivedDrafts(invoices, new Set(archivedInvoices.map((row) => String(row.record_id)))) : null) : invoices;
  const input: AttentionInput = {
    quotes, rfqs, purchaseOrders, lateJobs, finishedJobs, invoices: invoiceRows, deliveryNotes, unbilledJobs,
    quotedRfqIds: quoted ? quoted.map((row) => String(row.rfq_id)) : null,
  };
  return buildAttention(input, role, toDateInput(new Date()));
}
