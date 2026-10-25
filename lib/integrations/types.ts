// The integrations layer (G22): one interface for any accounting system Tolra pushes to. Xero is the only implementation; QuickBooks and
// similar plug in later behind the same interface. One way only: Tolra to the provider; nothing is ever read back into Tolra's records
// (the provider is read only to match contacts, to list accounts and tax rates for the mapping page, and to check a send that may or
// may not have arrived).

export type ProviderId = "xero";

/** A document line as migration 084's integration_document returns it: net and VAT worked out as Tolra totals it, and its VAT key. */
export type DocumentLine = {
  description: string;
  quantity: number;
  unit_price: number;
  net: number;
  vat: number;
  /** "20", "5", "0", "17.5", "exempt" or "no_vat"; null on a £0 text-only line. */
  vat_key: string | null;
  text_only: boolean;
  carriage?: boolean;
};

/** An issued invoice or credit note as it is sent (integration_document, 084). */
export type IntegrationDocument = {
  doc_type: "invoice" | "credit_note";
  id: string;
  number: string | null;
  date: string | null;
  due_date: string | null;
  /** The customer's PO on an invoice; the original invoice's number on a credit note. */
  reference: string | null;
  customer: string;
  status: string | null;
  voided: boolean;
  subtotal: number;
  carriage: number;
  vat: number;
  total: number;
  lines: DocumentLine[];
};

/** The company's mappings (integration_mappings, 084): account codes and one provider tax rate per Tolra VAT key. */
export type Mappings = { salesAccount: string | null; creditAccount: string | null; taxRates: Record<string, string> };

export type Totals = { subTotal: number; totalTax: number; total: number };

/** What the provider holds for a document after a push or a read-back. */
export type ProviderDocument = { externalId: string; externalNumber: string | null; status: string; totals: Totals };

export type ContactCandidate = { id: string; name: string; archived: boolean };

export type ContactDecision =
  | { kind: "link"; id: string }
  | { kind: "create" }
  | { kind: "problem"; reason: string };

/**
 * outcome says what is known after a call that may have changed something at the provider: "failed" (refused: nothing was created),
 * "unknown" (it may have arrived: a timeout, a network error, a 5xx), "rate_limited" (refused for now: try after retryAfterMs) or
 * "unauthorized" (401: the access token was refused) or "forbidden" (403: this app no longer has access to the organisation, e.g. the
 * connection was removed in Xero). Messages are safe to store: never a token or a secret.
 */
export class ProviderError extends Error {
  constructor(message: string, readonly outcome: "failed" | "unknown" | "rate_limited" | "unauthorized" | "forbidden", readonly status: number, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "ProviderError";
  }
}

/** One accounting system, for one connected organisation (tenant), with a valid access token. */
export interface AccountingProvider {
  readonly id: ProviderId;
  /** Active accounts; revenue: the account can take sales (Xero class REVENUE: types REVENUE, SALES, OTHERINCOME). */
  listAccounts(): Promise<Array<{ code: string; name: string; type: string; revenue: boolean }>>;
  /** Tax rates not deleted; revenue: Xero's CanApplyToRevenue; active: Xero's Status ACTIVE (not archived or pending). */
  listTaxRates(): Promise<Array<{ code: string; name: string; rate: number; revenue: boolean; active: boolean }>>;
  findContacts(name: string): Promise<ContactCandidate[]>;
  createContact(name: string, idempotencyKey: string): Promise<ContactCandidate>;
  pushInvoice(doc: IntegrationDocument, mappings: Mappings, contactId: string, idempotencyKey: string): Promise<ProviderDocument>;
  pushCreditNote(doc: IntegrationDocument, mappings: Mappings, contactId: string, idempotencyKey: string): Promise<ProviderDocument>;
  voidInvoice(externalId: string, idempotencyKey: string): Promise<ProviderDocument>;
  /** The provider's copy of a document by its Tolra number, or null when it has none. */
  readBack(docType: IntegrationDocument["doc_type"], number: string): Promise<ProviderDocument | null>;
}
