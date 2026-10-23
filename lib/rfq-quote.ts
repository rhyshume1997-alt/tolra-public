import { findCustomer, type CustomerRecord } from "@/lib/customers";
import { fromPence, toPence } from "@/lib/money";

/**
 * The first quote line made from an RFQ (RFQ page > Quote). The RFQ's value is its estimated TOTAL (the RFQ page shows it as
 * "Value" next to the quantity), so the line's unit price is value / quantity, rounded to the penny like the rest of the app's
 * money (lib/money). With no usable quantity the line is 1 at the whole value. Returns null when the RFQ has neither, so the
 * builder keeps its ordinary blank line.
 */
export function rfqQuoteLine(quantity: unknown, estimatedValue: unknown): { qty: number; unit: number } | null {
  const qty = Math.floor(Number(quantity));
  const value = Number(estimatedValue);
  const hasQty = Number.isFinite(qty) && qty > 0;
  const hasValue = Number.isFinite(value) && value > 0;
  if (!hasQty && !hasValue) return null;
  const lineQty = hasQty ? qty : 1;
  return { qty: lineQty, unit: hasValue ? fromPence(toPence(value / lineQty)) : 0 };
}

export type RfqEmailCarry = { action: "none" } | { action: "update" | "create"; customer: CustomerRecord };

/**
 * What to do with the RFQ's e-mail when its quote is saved, so Send finds an address (quotes keep only the customer's name; the
 * e-mail is read from the customer record). An existing customer's e-mail is never overwritten: only a blank one is filled.
 * A customer that does not exist yet is created with the RFQ's name and e-mail.
 */
export function planRfqEmailCarry(customers: CustomerRecord[], customerName: string, rfqEmail: string): RfqEmailCarry {
  const email = rfqEmail.trim();
  const name = customerName.trim();
  if (!email || !name) return { action: "none" };
  const existing = findCustomer(customers, name);
  if (!existing) return { action: "create", customer: { name, contactName: "", email, phone: "", address: "", notes: "" } };
  if (existing.email.trim()) return { action: "none" };
  return { action: "update", customer: { ...existing, email } };
}
