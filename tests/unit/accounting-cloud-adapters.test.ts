import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { cloudAuthorize, cloudBalance, cloudConfig, cloudTenant, cloudTokens, moneyPence } from "@/lib/accounting/cloud-adapters";
import { encryptSecret, decryptSecret } from "@/lib/integrations/crypto";

const config = { clientId: "fake-id", clientSecret: "fake-secret", redirectUri: "https://tolra.example.test/api/accounting/sage/callback", sandbox: true };
const reply = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));

describe("free developer app adapters remain off without valid configuration", () => {
  it("requires every credential and exact callback path; QBO defaults to sandbox", () => {
    expect(cloudConfig("sage", {})).toBeNull();
    expect(cloudConfig("sage", { SAGE_CLIENT_ID: "x", SAGE_CLIENT_SECRET: "y", SAGE_REDIRECT_URI: "https://evil.test/wrong" })).toBeNull();
    for (const redirect of ["http://public.example/api/accounting/sage/callback", "https://user:password@host/api/accounting/sage/callback", "https://host/api/accounting/sage/callback?next=evil"]) {
      expect(cloudConfig("sage", { SAGE_CLIENT_ID: "x", SAGE_CLIENT_SECRET: "y", SAGE_REDIRECT_URI: redirect })).toBeNull();
    }
    expect(cloudConfig("quickbooks", { QUICKBOOKS_CLIENT_ID: "x", QUICKBOOKS_CLIENT_SECRET: "y", QUICKBOOKS_REDIRECT_URI: "https://tolra.example.test/api/accounting/quickbooks/callback" })?.sandbox).toBe(true);
  });
  it("keeps secrets out of authorization URLs and binds state for all three adapters", () => {
    for (const id of ["sage", "quickbooks", "xero"] as const) {
      const url = new URL(cloudAuthorize(id, config, "fake-state", "fake-challenge"));
      expect(url.searchParams.get("state")).toBe("fake-state");
      expect(url.searchParams.get("client_secret")).toBeNull();
      expect(url.toString()).not.toContain(config.clientSecret);
    }
  });
  it("exchanges Sage and QBO codes server-side and refuses incomplete tokens", async () => {
    for (const id of ["sage", "quickbooks"] as const) {
      const fetchImpl = reply({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 });
      expect((await cloudTokens(id, config, { code: "fake-code", verifier: "fake-verifier" }, fetchImpl)).refreshToken).toBe("fake-refresh");
      expect(fetchImpl.mock.calls[0][1]?.method).toBe("POST");
      await expect(cloudTokens(id, config, { refreshToken: "fake-refresh" }, reply({ access_token: "broken" }))).rejects.toThrow();
    }
  });
  it("binds encrypted tokens to both company and adapter", () => {
    const key = Buffer.alloc(32, 1);
    const value = encryptSecret("fake-token", { organizationId: "company-a", provider: "sage", purpose: "access" }, key);
    expect(decryptSecret(value, { organizationId: "company-a", provider: "sage", purpose: "access" }, key)).toBe("fake-token");
    for (const ctx of [{ organizationId: "company-b", provider: "sage" }, { organizationId: "company-a", provider: "quickbooks" }]) expect(() => decryptSecret(value, { ...ctx, purpose: "access" }, key)).toThrow();
  });
});
describe("connect chooses a verified external company", () => {
  it("refuses zero or multiple Sage businesses rather than choosing a company", async () => {
    for (const businesses of [[], [{ id: "a", name: "A" }, { id: "b", name: "B" }]]) await expect(cloudTenant("sage", config, "token", null, reply({ $items: businesses }))).rejects.toThrow();
    await expect(cloudTenant("sage", config, "token", null, reply({ $items: [{ id: "a", name: "A" }], $next: "another-page" }))).rejects.toThrow();
    expect(await cloudTenant("sage", config, "token", null, reply({ $items: [{ id: "a", name: "Fake Company" }] }))).toEqual({ id: "a", name: "Fake Company" });
  });
  it("verifies QBO realm through that realm's authenticated company-info endpoint", async () => {
    const fetchImpl = reply({ CompanyInfo: { Id: "1", CompanyName: "Fake Company" } });
    expect(await cloudTenant("quickbooks", config, "token", "123", fetchImpl)).toEqual({ id: "123", name: "Fake Company" });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://sandbox-quickbooks.api.intuit.com/v3/company/123/companyinfo/123");
    await expect(cloudTenant("quickbooks", config, "token", "../other", fetchImpl)).rejects.toThrow();
  });
});
describe("read-only exact invoice balance evidence in pence", () => {
  const cases = [
    { id: "sage" as const, body: { $items: [{ invoice_number: "INV-1", total_amount: "120.50", outstanding_amount: "20.50", currency: { id: "GBP" } }] } },
    { id: "quickbooks" as const, body: { QueryResponse: { Invoice: [{ DocNumber: "INV-1", TotalAmt: 120.5, Balance: 20.5, CurrencyRef: { value: "GBP" } }] } } },
    { id: "xero" as const, body: { Invoices: [{ InvoiceNumber: "INV-1", Total: 120.5, AmountDue: 20.5, CurrencyCode: "GBP" }] } },
  ];
  for (const { id, body } of cases) it(`${id} checks using GET only and never marks a Tolra invoice paid`, async () => {
    const fetchImpl = reply(body);
    expect(await cloudBalance(id, config, "token", "123", "INV-1", fetchImpl)).toEqual({ invoiceNumber: "INV-1", totalPence: 12050, outstandingPence: 2050, currency: "GBP", reviewOnly: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    if (id === "sage") expect(headers["X-Business"]).toBe("123");
    if (id === "xero") expect(headers["xero-tenant-id"]).toBe("123");
  });
  it("refuses duplicate, non-GBP or malformed amount evidence", async () => {
    const invoice = { invoice_number: "INV-1", total_amount: "120.50", outstanding_amount: "0.00", currency: { id: "GBP" } };
    for (const $items of [[invoice, invoice], [{ ...invoice, currency: { id: "USD" } }], [{ ...invoice, outstanding_amount: "NaN" }]]) await expect(cloudBalance("sage", config, "token", "company", "INV-1", reply({ $items }))).rejects.toThrow();
    await expect(cloudBalance("sage", config, "token", "company", "INV-1", reply({ $items: [invoice], $next: "another-page" }))).rejects.toThrow();
    expect(await cloudBalance("sage", config, "token", "company", "OTHER", reply({ $items: [invoice] }))).toBeNull();
    expect(moneyPence("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => moneyPence("90071992547409.92")).toThrow();
    for (const amount of [null, "", "1.005", "999999999999999999999", "Infinity"]) expect(() => moneyPence(amount)).toThrow();
  });
  it("uses safe generic errors, never provider response bodies or tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-token', { status: 500 }));
    await expect(cloudBalance("sage", config, "secret-token", "company", "INV-1", fetchImpl)).rejects.toThrow("Accounting connection: unavailable");
  });
});
