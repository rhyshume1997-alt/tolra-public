import "server-only";

import type { AccountingProvider, ContactCandidate, IntegrationDocument, Mappings, ProviderDocument } from "@/lib/integrations/types";
import { ProviderError } from "@/lib/integrations/types";
import { mapCreditNote, mapInvoice } from "@/lib/integrations/xero/mapper";

// The Xero Accounting API for one connected organisation (tenant), with a valid access token. Every write carries an Idempotency-Key
// (the send log row's id), so a retried request is not applied twice; a response that leaves the outcome unknown (a timeout, a network
// error, a 5xx) is reported as such and the caller reads the document back before trying again. Xero's limits (60 calls a minute and 5 at
// once per organisation): the caller sends one document at a time, and a 429 is reported with its Retry-After. Errors carry Xero's
// validation messages (safe: they describe the document) and never a token.

export const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const TIMEOUT_MS = 20_000;
/** Xero's account types in its REVENUE class: the only ones sales and credit notes may be posted to. */
export const XERO_REVENUE_ACCOUNT_TYPES: readonly string[] = ["REVENUE", "SALES", "OTHERINCOME"];

type XeroDocJson = {
  InvoiceID?: string; InvoiceNumber?: string; CreditNoteID?: string; CreditNoteNumber?: string; Status?: string; Type?: string;
  SubTotal?: number; TotalTax?: number; Total?: number; HasErrors?: boolean; ValidationErrors?: Array<{ Message?: string }>;
};

/** Xero's own words for a refused request (validation messages), trimmed; never the request or a token. */
function xeroMessage(json: unknown, status: number): string {
  const j = json as { Message?: unknown; Detail?: unknown; Elements?: Array<{ ValidationErrors?: Array<{ Message?: unknown }> }>; Title?: unknown } | null;
  const messages = (j?.Elements ?? []).flatMap((e) => (e.ValidationErrors ?? []).map((v) => (typeof v.Message === "string" ? v.Message : ""))).filter(Boolean);
  const text = messages.length ? messages.join("; ") : typeof j?.Detail === "string" ? j.Detail : typeof j?.Message === "string" ? j.Message : typeof j?.Title === "string" ? j.Title : `HTTP ${status}`;
  return text.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 60_000;
}

function toProviderDocument(d: XeroDocJson | undefined, kind: "invoice" | "credit_note"): ProviderDocument | null {
  const id = kind === "invoice" ? d?.InvoiceID : d?.CreditNoteID;
  if (!d || !id) return null;
  return {
    externalId: id,
    externalNumber: (kind === "invoice" ? d.InvoiceNumber : d.CreditNoteNumber) ?? null,
    status: d.Status ?? "",
    totals: { subTotal: Number(d.SubTotal ?? 0), totalTax: Number(d.TotalTax ?? 0), total: Number(d.Total ?? 0) },
  };
}

/** A Xero where-clause string literal: the value in double quotes, with backslashes and quotes escaped. */
export function xeroString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function createXeroClient(opts: { accessToken: string; tenantId: string; fetchImpl?: typeof fetch; apiBase?: string }): AccountingProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? XERO_API_BASE;

  async function call(method: "GET" | "PUT" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.accessToken}`, "xero-tenant-id": opts.tenantId, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey.slice(0, 128);
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      // A write may have reached Xero before the connection dropped: unknown. A read changed nothing either way.
      throw new ProviderError("No answer from Xero (timeout or network error)", "unknown", 0);
    }
    const json = await res.json().catch(() => null);
    if (res.status === 429) throw new ProviderError("Xero's rate limit was reached", "rate_limited", 429, retryAfterMs(res));
    if (res.status === 401) throw new ProviderError("Xero refused the access token", "unauthorized", 401);
    if (res.status === 403) throw new ProviderError("Xero refused access to this organisation (the connection may have been removed in Xero): connect again", "forbidden", 403);
    if (res.status >= 500) throw new ProviderError(`Xero had a problem (HTTP ${res.status}): ${xeroMessage(json, res.status)}`, "unknown", res.status);
    if (!res.ok) throw new ProviderError(`Xero refused it: ${xeroMessage(json, res.status)}`, "failed", res.status);
    if (json === null) throw new ProviderError("Xero's answer could not be read", "unknown", res.status);
    return json;
  }

  async function push(kind: "invoice" | "credit_note", payload: unknown, idempotencyKey: string): Promise<ProviderDocument> {
    const path = kind === "invoice" ? "/Invoices" : "/CreditNotes";
    const json = (await call("PUT", path, kind === "invoice" ? { Invoices: [payload] } : { CreditNotes: [payload] }, idempotencyKey)) as { Invoices?: XeroDocJson[]; CreditNotes?: XeroDocJson[] };
    const doc = (kind === "invoice" ? json.Invoices : json.CreditNotes)?.[0];
    if (doc?.HasErrors) throw new ProviderError(`Xero refused it: ${(doc.ValidationErrors ?? []).map((v) => v.Message).filter(Boolean).join("; ").slice(0, 300)}`, "failed", 400);
    const out = toProviderDocument(doc, kind);
    if (!out) throw new ProviderError("Xero answered without the document's id", "unknown", 200);
    return out;
  }

  return {
    id: "xero",

    async listAccounts() {
      const json = (await call("GET", "/Accounts?where=" + encodeURIComponent('Status=="ACTIVE"'))) as {
        Accounts?: Array<{ Code?: string; Name?: string; Type?: string; Class?: string; Status?: string }>;
      };
      return (json.Accounts ?? []).filter((a) => a.Code && (a.Status ?? "ACTIVE") === "ACTIVE").map((a) => ({
        code: a.Code!, name: a.Name ?? "", type: a.Type ?? "", revenue: a.Class === "REVENUE" || XERO_REVENUE_ACCOUNT_TYPES.includes(a.Type ?? ""),
      }));
    },

    async listTaxRates() {
      const json = (await call("GET", "/TaxRates")) as { TaxRates?: Array<{ TaxType?: string; Name?: string; EffectiveRate?: number; Status?: string; CanApplyToRevenue?: boolean }> };
      return (json.TaxRates ?? []).filter((t) => t.TaxType && t.Status !== "DELETED").map((t) => ({
        code: t.TaxType!, name: t.Name ?? "", rate: Number(t.EffectiveRate ?? 0), revenue: t.CanApplyToRevenue === true, active: t.Status === "ACTIVE",
      }));
    },

    async findContacts(name: string): Promise<ContactCandidate[]> {
      const where = encodeURIComponent(`Name==${xeroString(name.trim())}`);
      const json = (await call("GET", `/Contacts?where=${where}&includeArchived=true`)) as { Contacts?: Array<{ ContactID?: string; Name?: string; ContactStatus?: string }> };
      return (json.Contacts ?? []).filter((c) => c.ContactID).map((c) => ({ id: c.ContactID!, name: c.Name ?? "", archived: c.ContactStatus === "ARCHIVED" }));
    },

    async createContact(name: string, idempotencyKey: string): Promise<ContactCandidate> {
      const json = (await call("PUT", "/Contacts", { Contacts: [{ Name: name.trim() }] }, idempotencyKey)) as { Contacts?: Array<{ ContactID?: string; Name?: string }> };
      const c = json.Contacts?.[0];
      if (!c?.ContactID) throw new ProviderError("Xero answered without the contact's id", "unknown", 200);
      return { id: c.ContactID, name: c.Name ?? name, archived: false };
    },

    async pushInvoice(doc: IntegrationDocument, mappings: Mappings, contactId: string, idempotencyKey: string) {
      return push("invoice", mapInvoice(doc, mappings, contactId), idempotencyKey);
    },

    async pushCreditNote(doc: IntegrationDocument, mappings: Mappings, contactId: string, idempotencyKey: string) {
      return push("credit_note", mapCreditNote(doc, mappings, contactId), idempotencyKey);
    },

    async voidInvoice(externalId: string, idempotencyKey: string) {
      const json = (await call("POST", `/Invoices/${encodeURIComponent(externalId)}`, { Invoices: [{ InvoiceID: externalId, Status: "VOIDED" }] }, idempotencyKey)) as { Invoices?: XeroDocJson[] };
      const out = toProviderDocument(json.Invoices?.[0], "invoice");
      if (!out) throw new ProviderError("Xero answered without the invoice", "unknown", 200);
      return out;
    },

    async readBack(docType, number) {
      if (docType === "invoice") {
        const json = (await call("GET", `/Invoices?InvoiceNumbers=${encodeURIComponent(number)}`)) as { Invoices?: XeroDocJson[] };
        const found = (json.Invoices ?? []).filter((d) => d.Type === "ACCREC" && d.InvoiceNumber === number && d.Status !== "DELETED");
        return toProviderDocument(found[0], "invoice");
      }
      const where = encodeURIComponent(`CreditNoteNumber==${xeroString(number)}`);
      const json = (await call("GET", `/CreditNotes?where=${where}`)) as { CreditNotes?: XeroDocJson[] };
      const found = (json.CreditNotes ?? []).filter((d) => d.CreditNoteNumber === number && d.Status !== "DELETED");
      return toProviderDocument(found[0], "credit_note");
    },
  };
}
