/**
 * Issued-document snapshots (migration 019, audit D9). Quotes and invoices created since then carry the issuer's
 * and the customer's details as they were when issued; a reprint uses those, so later changes to the company
 * profile (address, VAT registration, standard rate, terms) or to the customer record don't alter it. Branding
 * (logo, colours) still comes from today's profile. Documents from before 019 have no snapshot and print from
 * current details, as they always did.
 */
import type { CompanyProfile } from "@/lib/company";
import { customerAddressLines } from "@/lib/customers";

const ISSUER_FIELDS = [
  "name", "documentName", "addressLines", "phone", "fax", "email", "website", "vatNumber", "vatRegistered",
  "defaultVatRate", "defaultInvoiceTerms", "defaultQuoteTerms", "defaultCustomerMessage", "defaultInvoiceMessage",
] as const;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The company as it was when the document was issued (current profile when there is no snapshot). */
export function issuedCompany(current: CompanyProfile, snapshot: unknown): CompanyProfile {
  if (!isObject(snapshot)) return current;
  const issued: CompanyProfile = { ...current };
  for (const field of ISSUER_FIELDS) {
    const value = snapshot[field];
    if (value === undefined || value === null) continue;
    if (field === "addressLines" || field === "defaultCustomerMessage" || field === "defaultInvoiceMessage") {
      if (Array.isArray(value)) (issued[field] as string[]) = value.map(String);
    } else if (field === "vatRegistered") {
      issued.vatRegistered = value !== false;
    } else if (field === "defaultVatRate") {
      if (typeof value === "number" && Number.isFinite(value)) issued.defaultVatRate = value;
    } else if (typeof value === "string") {
      (issued[field] as string) = value;
    }
  }
  // A snapshot taken before invoices had a message of their own (migration 032) printed the company's one shared message
  // on its invoice: keep exactly that, whatever the company has set since. Newer snapshots carry the key (maybe empty).
  if (!("defaultInvoiceMessage" in snapshot)) issued.defaultInvoiceMessage = [...issued.defaultCustomerMessage];
  return issued;
}

/** The customer's printable address as recorded at issue, or null when the document has no snapshot. */
export function issuedBillTo(snapshot: unknown, fallbackName: string): string[] | null {
  if (!isObject(snapshot)) return null;
  const name = typeof snapshot.name === "string" && snapshot.name ? snapshot.name : fallbackName;
  const address = typeof snapshot.address === "string" ? snapshot.address : "";
  return customerAddressLines(name, { name, address } as Parameters<typeof customerAddressLines>[1]);
}
