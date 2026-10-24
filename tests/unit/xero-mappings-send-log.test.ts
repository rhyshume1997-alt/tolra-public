/**
 * Xero PR 2 (G22, no migration): the mapping page's rules (what still stops sending; the tax-rate cross-check against Xero's own list:
 * the PR 1 verifier's should-fix), the send log's states as the page shows them, and the "does the database have 084?" probe that hides
 * Admin > Integrations until it does. Pure or rendered to markup; no database, no Xero.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ result: { data: [], error: null } as { data: unknown; error: { code?: string; message?: string } | null } }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => ({ select: () => ({ limit: async () => probe.result }) }) },
}));

import { MappingStatus } from "@/components/xero-mappings";
import { SendLogTable } from "@/components/xero-send-log";
import { databaseHas084, resetDatabaseFeatureCache } from "@/lib/db-features";
import {
  type MappingRow, type XeroTaxRate, checkAccount, checkTaxRate, mappingCompleteness, matchingTaxRates, parseMappingRequest, tolraVatPercent, usableAccounts,
  usableTaxRates, vatKeysToShow,
} from "@/lib/integrations/mappings";
import { type SendLogRow, canRetry, filterSendLog, issuedByMap, retryErrorMessage, sendLogView } from "@/lib/integrations/send-log";

const sales = { revenue: true, active: true };
const XERO_RATES: XeroTaxRate[] = [
  { code: "OUTPUT2", name: "20% (VAT on Income)", rate: 20, ...sales },
  { code: "RROUTPUT", name: "5% (VAT on Income)", rate: 5, ...sales },
  { code: "ZERORATEDOUTPUT", name: "Zero Rated Income", rate: 0, ...sales },
  { code: "EXEMPTOUTPUT", name: "Exempt Income", rate: 0, ...sales },
  { code: "NONE", name: "No VAT", rate: 0, ...sales },
  { code: "INPUT2", name: "20% (VAT on Expenses)", rate: 20, revenue: false, active: true },
  { code: "OLDOUTPUT", name: "Old 20% (archived)", rate: 20, revenue: true, active: false },
];

const row = (kind: MappingRow["kind"], code: string, key = ""): MappingRow => ({ kind, tolra_key: key, external_code: code, external_name: null });

describe("mapping completeness", () => {
  it("both account codes are always needed, even with nothing waiting", () => {
    const c = mappingCompleteness([], []);
    expect(c.ready).toBe(false);
    expect(c.missing).toEqual(["the sales account", "the credit note account"]);
    expect(c.message).toBe("Nothing is sent to Xero until these are set: the sales account, the credit note account.");
  });

  it("a VAT rate is needed once a waiting document uses it; one saved since the overview was read counts as done", () => {
    const rows = [row("sales_account", "200"), row("credit_account", "260"), row("tax_rate", "OUTPUT2", "20")];
    const c = mappingCompleteness(rows, ["vat:20", "vat:exempt", "vat:no_vat"]);
    expect(c.missing).toEqual(["VAT Exempt", "VAT No VAT"]);
    expect(c.ready).toBe(false);
    expect(mappingCompleteness([...rows, row("tax_rate", "EXEMPTOUTPUT", "exempt"), row("tax_rate", "NONE", "no_vat")], ["vat:20", "vat:exempt", "vat:no_vat"]))
      .toEqual({ ready: true, missing: [], message: null });
  });

  it("an unused VAT rate does not stop sending; the account codes do", () => {
    expect(mappingCompleteness([row("sales_account", "200"), row("credit_account", "260")], []).ready).toBe(true);
    expect(mappingCompleteness([row("sales_account", "200")], ["vat:20"]).missing).toEqual(["the credit note account", "VAT 20%"]);
  });

  it("lists 20%, 5%, 0%, exempt and no VAT, then any other rate in use or mapped (an older 17.5%)", () => {
    expect(vatKeysToShow([], [])).toEqual(["20", "5", "0", "exempt", "no_vat"]);
    expect(vatKeysToShow([row("tax_rate", "X", "15")], ["vat:17.5", "account:sales"])).toEqual(["20", "5", "0", "exempt", "no_vat", "17.5", "15"]);
  });

  it("renders the plain missing line, or that documents are sent", () => {
    const missing = renderToStaticMarkup(createElement(MappingStatus, { rows: [], unmapped: ["vat:5"] }));
    expect(missing).toContain("Nothing is sent to Xero until these are set: the sales account, the credit note account, VAT 5%.");
    const ready = renderToStaticMarkup(createElement(MappingStatus, { rows: [row("sales_account", "200"), row("credit_account", "260")], unmapped: [] }));
    expect(ready).toContain("Documents are sent.");
  });
});

describe("tax-rate cross-check against Xero's list", () => {
  it("each Tolra rate's percentage: exempt and no VAT are 0%", () => {
    expect(["20", "5", "0", "exempt", "no_vat", "17.5"].map(tolraVatPercent)).toEqual([20, 5, 0, 0, 0, 17.5]);
  });

  it("accepts a Xero rate with the same percentage", () => {
    expect(checkTaxRate("20", "OUTPUT2", XERO_RATES)).toMatchObject({ ok: true, rate: { code: "OUTPUT2" } });
    expect(checkTaxRate("5", "RROUTPUT", XERO_RATES).ok).toBe(true);
    for (const key of ["0", "exempt", "no_vat"]) expect(checkTaxRate(key, "ZERORATEDOUTPUT", XERO_RATES).ok, key).toBe(true);
  });

  it("refuses a mismatch with a clear message", () => {
    expect(checkTaxRate("20", "ZERORATEDOUTPUT", XERO_RATES)).toEqual({
      ok: false, message: 'Not saved: Xero\'s "Zero Rated Income" is 0%, but Tolra\'s VAT 20% is 20%. Pick a Xero tax rate of 20%.',
    });
    expect(checkTaxRate("exempt", "OUTPUT2", XERO_RATES)).toEqual({
      ok: false, message: 'Not saved: Xero\'s "20% (VAT on Income)" is 20%, but Tolra\'s VAT Exempt is 0%. Pick a Xero tax rate of 0%.',
    });
    expect(checkTaxRate("5", "OUTPUT2", XERO_RATES).ok).toBe(false);
  });

  it("refuses a code that isn't in the organisation's list, and a key that isn't a Tolra VAT rate", () => {
    expect(checkTaxRate("20", "MADEUP", XERO_RATES)).toEqual({ ok: false, message: "That tax rate isn't in this company's Xero. Pick one from the list." });
    expect(checkTaxRate("twenty", "OUTPUT2", XERO_RATES).ok).toBe(false);
  });

  it("refuses a purchases-only rate (VAT on Expenses) and an archived one, even at the right percentage", () => {
    expect(checkTaxRate("20", "INPUT2", XERO_RATES)).toEqual({
      ok: false, message: 'Not saved: Xero\'s "20% (VAT on Expenses)" can\'t be used on sales (it is for purchases). Pick a tax rate for sales.',
    });
    expect(checkTaxRate("20", "OLDOUTPUT", XERO_RATES)).toEqual({ ok: false, message: 'Not saved: Xero\'s "Old 20% (archived)" is archived in Xero. Pick an active tax rate.' });
    expect(usableTaxRates(XERO_RATES).map((r) => r.code)).toEqual(["OUTPUT2", "RROUTPUT", "ZERORATEDOUTPUT", "EXEMPTOUTPUT", "NONE"]);
  });

  it("the page offers only active sales rates with the matching percentage", () => {
    expect(matchingTaxRates("20", XERO_RATES).map((r) => r.code)).toEqual(["OUTPUT2"]);
    expect(matchingTaxRates("exempt", XERO_RATES).map((r) => r.code)).toEqual(["ZERORATEDOUTPUT", "EXEMPTOUTPUT", "NONE"]);
    expect(matchingTaxRates("17.5", XERO_RATES)).toEqual([]);
  });

  it("an account code must be one of Xero's active revenue accounts", () => {
    const accounts = [{ code: "200", name: "Sales", type: "REVENUE", revenue: true }, { code: "090", name: "Business Bank", type: "BANK", revenue: false }];
    expect(checkAccount("200", accounts)).toMatchObject({ ok: true, account: { name: "Sales" } });
    expect(checkAccount("999", accounts).ok).toBe(false);
    expect(checkAccount("090", accounts)).toEqual({ ok: false, message: "Not saved: 090 Business Bank isn't a sales (revenue) account in Xero. Pick a revenue account." });
    expect(usableAccounts(accounts).map((a) => a.code)).toEqual(["200"]);
  });

  it("the save request: only the three kinds, a Tolra VAT key for a tax rate, a short code (blank removes)", () => {
    expect(parseMappingRequest({ kind: "tax_rate", tolraKey: " Exempt ", code: " EXEMPTOUTPUT " })).toEqual({ kind: "tax_rate", tolraKey: "exempt", code: "EXEMPTOUTPUT" });
    expect(parseMappingRequest({ kind: "sales_account", tolraKey: "20", code: "200" })).toEqual({ kind: "sales_account", tolraKey: "", code: "200" });
    expect(parseMappingRequest({ kind: "credit_account", code: "" })).toEqual({ kind: "credit_account", tolraKey: "", code: "" });
    expect(parseMappingRequest({ kind: "tax_rate", tolraKey: "twenty", code: "X" })).toBeNull();
    expect(parseMappingRequest({ kind: "token", code: "X" })).toBeNull();
    expect(parseMappingRequest({ kind: "sales_account", code: "x".repeat(51) })).toBeNull();
    expect(parseMappingRequest(null)).toBeNull();
  });
});

const send = (over: Partial<SendLogRow>): SendLogRow => ({
  id: "s-1", doc_type: "invoice", doc_id: "d-1", doc_ref: "INV-0042", action: "create", status: "sent", attempts: 1, external_number: "INV-0042",
  last_error: null, created_at: "2026-10-21T09:00:00Z", updated_at: "2026-10-21T09:01:00Z", sent_at: "2026-10-21T09:01:00Z", ...over,
});

describe("send log", () => {
  it("each state in plain words: sent / failed with the reason / waiting / not sent / check in Xero", () => {
    expect(sendLogView(send({}))).toMatchObject({ label: "Sent", badge: "complete", document: "Invoice INV-0042", detail: null, retry: false });
    expect(sendLogView(send({ status: "failed", sent_at: null, last_error: "Xero refused it: Contact is archived" })))
      .toMatchObject({ label: "Failed", badge: "sync_failed", detail: "Xero refused it: Contact is archived", retry: true, when: "2026-10-21T09:01:00Z" });
    expect(sendLogView(send({ status: "pending", sent_at: null }))).toMatchObject({ label: "Waiting to send", detail: null, retry: false });
    expect(sendLogView(send({ status: "skipped", sent_at: null, last_error: "Disconnected before it was sent" })))
      .toMatchObject({ label: "Not sent", badge: "cancelled", detail: "Disconnected before it was sent", retry: false });
    expect(sendLogView(send({ status: "needs_check", sent_at: null })).retry).toBe(true);
    expect(sendLogView(send({ doc_type: "credit_note", doc_ref: "CN-0007" })).document).toBe("Credit note CN-0007");
    expect(sendLogView(send({ action: "void" })).document).toBe("Void of invoice INV-0042");
  });

  it("Retry only where 084's integration_retry_send allows it", () => {
    expect((["pending", "sending", "sent", "failed", "needs_check", "skipped"] as const).filter(canRetry)).toEqual(["failed", "needs_check"]);
  });

  it("filters: problems are failed or to check", () => {
    const rows = [send({ id: "a" }), send({ id: "b", status: "failed" }), send({ id: "c", status: "needs_check" }), send({ id: "d", status: "pending" })];
    expect(filterSendLog(rows, "problems").map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterSendLog(rows, "pending").map((r) => r.id)).toEqual(["d"]);
    expect(filterSendLog(rows, "all")).toHaveLength(4);
  });

  it("renders the Tolra number, the state, the reason, when, who issued it, and Retry on the failed row only", () => {
    const rows = [
      send({ id: "a", doc_id: "d-a" }),
      send({ id: "b", doc_id: "d-b", doc_ref: "INV-0043", status: "failed", sent_at: null, last_error: "Xero refused it: Account code 200 is archived" }),
      send({ id: "c", doc_id: "d-c", doc_ref: "CN-0001", doc_type: "credit_note", status: "pending", sent_at: null }),
      send({ id: "d", doc_id: "d-d", doc_ref: "INV-0044", status: "skipped", sent_at: null, last_error: "Disconnected before it was sent" }),
    ];
    const html = renderToStaticMarkup(createElement(SendLogTable, {
      rows, people: { "u-1": "Dave" }, issuedBy: { "d-a": "u-1", "d-b": "u-1", "d-c": null }, onRetry: () => undefined,
    }));
    expect(html).toContain("Invoice INV-0042");
    expect(html).toContain("Invoice INV-0043");
    expect(html).toContain("Credit note CN-0001");
    expect(html).toContain(">Sent<");
    expect(html).toContain(">Failed<");
    expect(html).toContain(">Waiting to send<");
    expect(html).toContain(">Not sent<");
    expect(html).toContain("Account code 200 is archived");
    expect(html).toContain("Disconnected before it was sent");
    expect(html).toContain("21/10/2026");
    expect(html).toContain(">Dave<");
    expect(html).toContain(">—<");
    expect(html.match(/>Retry</g)).toHaveLength(1);
    expect(html).not.toMatch(/token|secret/i);
    // Without a retry handler (not an admin's action) there is no button.
    expect(renderToStaticMarkup(createElement(SendLogTable, { rows, people: {}, issuedBy: {} }))).not.toContain(">Retry<");
    expect(renderToStaticMarkup(createElement(SendLogTable, { rows: [], people: {}, issuedBy: {} }))).toContain("Nothing in the send log yet.");
  });

  it("who issued each document, and the retry refusals in plain words", () => {
    expect(issuedByMap([{ id: "i", issued_by: "u-1" }], [{ id: "c", issued_by: null }, { nope: 1 }])).toEqual({ i: "u-1", c: null });
    expect(retryErrorMessage({ code: "42501", hint: "mfa_required" })).toBe("Confirm your authenticator code first.");
    expect(retryErrorMessage({ code: "42501" })).toBe("Only an admin can send a document again.");
    expect(retryErrorMessage({ code: "22023", hint: "not_retryable" })).toContain("already waiting");
  });
});

describe("hidden until the database has 084", () => {
  beforeEach(() => resetDatabaseFeatureCache());

  it("a missing integration_mappings table means not yet", async () => {
    probe.result = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.integration_mappings' in the schema cache" } };
    expect(await databaseHas084()).toBe(false);
  });

  it("present when the table can be read (no rows for a non-admin still counts)", async () => {
    probe.result = { data: [], error: null };
    expect(await databaseHas084()).toBe(true);
  });

  it("any other failure is not an answer: not hidden for it (as 067 and 068), and asked again next time", async () => {
    probe.result = { data: null, error: { code: "08006", message: "network" } };
    expect(await databaseHas084()).toBe(true);
    probe.result = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.integration_mappings' in the schema cache" } };
    expect(await databaseHas084()).toBe(false);
  });
});
