import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/fetch-all";
import { balanceDue, invoiceLifecycle } from "@/lib/receivables";
import { fromPence, gbp, toPence } from "@/lib/money";
import { toDateInput } from "@/lib/dates";
import { cleanAddress } from "@/lib/email/send-company-email";

export const STATEMENT_PREFIX = "customer_statement:";
export async function customerStatement(db: SupabaseClient, org: string, customerId: string, today = toDateInput(new Date())) {
  const { data: customer, error } = await db.from("customers").select("id, organization_id, name, email").eq("id", customerId).eq("organization_id", org).maybeSingle();
  if (error || !customer) throw new Error("Customer not found.");
  const to = cleanAddress(customer.email);
  if (!to) throw new Error("Set a valid email address for this customer first.");
  const { data: names, error: namesError } = await db.from("customers").select("id").eq("organization_id", org).ilike("name", String(customer.name).replace(/[\\%_]/g, "\\$&")).limit(2);
  if (namesError || names?.length !== 1) throw new Error("More than one customer has this name, or it could not be checked. Resolve it before making a statement.");
  const { rows, truncated } = await fetchAll((from, to) => db.from("invoices")
    .select("id, invoice_ref, customer, total, amount_paid, credited_amount, refunded_amount, status, due_date, payment_unverified")
    .eq("organization_id", org).eq("customer", customer.name).order("id").range(from, to));
  if (truncated) throw new Error("Too many invoices to make a complete statement. Nothing was drafted.");
  const items: Array<{ id: string; reference: string; due: string; pence: number }> = [];
  for (const row of rows) {
    if (invoiceLifecycle(String(row.status)) !== "collectible" || row.payment_unverified) continue;
    const values = [row.total, row.amount_paid, row.credited_amount, row.refunded_amount].map((v) => v == null ? 0 : Number(v));
    if (values.some((v) => !Number.isFinite(v))) throw new Error("An invoice amount is invalid. Nothing was drafted.");
    const pence = toPence(balanceDue(values[0], values[1], values[2], values[3]));
    if (pence <= 0) continue;
    if (!row.invoice_ref) throw new Error("An outstanding invoice has no number. Nothing was drafted.");
    items.push({ id: String(row.id), reference: String(row.invoice_ref), due: String(row.due_date ?? "No due date"), pence });
  }
  const { data: credits, error: creditError } = await db.rpc("customer_credit");
  if (creditError || !Array.isArray(credits)) throw new Error("Customer credits could not be checked. Nothing was drafted.");
  const available = credits.filter((r: { customer?: string }) => r.customer?.trim().toLowerCase() === String(customer.name).trim().toLowerCase());
  if (available.length > 1) throw new Error("Customer credit is ambiguous. Nothing was drafted.");
  const credit = Number(available[0]?.credit ?? 0);
  if (!Number.isFinite(credit) || credit < 0) throw new Error("Customer credit is invalid. Nothing was drafted.");
  const creditPence = toPence(credit);
  const fingerprint = createHash("sha256").update(JSON.stringify([org, customer.id, to, items, creditPence])).digest("hex");
  const recordId = `${STATEMENT_PREFIX}${customer.id}:${fingerprint}`;
  const total = items.reduce((sum, row) => sum + row.pence, 0);
  const text = [`Hello ${customer.name},`, "", `Customer statement as at ${today}`, "", ...items.map((r) => `${r.reference} | Due ${r.due} | Outstanding ${gbp(fromPence(r.pence), 2)}`),
    items.length ? "" : "No confirmed outstanding invoices.", `Total outstanding invoices: ${gbp(fromPence(total), 2)}`, `Unallocated credit (shown separately): ${gbp(fromPence(creditPence), 2)}`, "",
    "Unconfirmed imported invoices are not included. Credits shown separately have not been allocated here.", "Please check this statement and contact us if anything is missing."].join("\n");
  if (text.length > 20_000) throw new Error("This statement is too long for an email draft. Nothing was drafted.");
  return { to, subject: `Customer statement — ${today}`, text, recordId };
}
