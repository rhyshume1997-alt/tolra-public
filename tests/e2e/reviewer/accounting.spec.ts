import { expect, test } from "@playwright/test";
import { createDecipheriv } from "node:crypto";
// Independent AES-GCM oracle: do not import Next server-only modules into Playwright.
function decryptSecret(stored: string, context: { organizationId: string; provider: string; purpose: string }, key: Buffer) {
  const [version, iv, tag, data] = stored.split(".");
  expect(version).toBe("v1");
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  cipher.setAAD(Buffer.from(`tolra:${context.organizationId}:${context.provider}:${context.purpose}`));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([cipher.update(Buffer.from(data, "base64url")), cipher.final()]).toString("utf8");
}
import { adminClient, createSoloTenant } from "../../support/fixtures";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../../support/optional-browser-database";
import { signIn, world } from "../helpers";
test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);

test("V-ACCOUNTING: real callbacks encrypt tokens, providers stay separate and another company cannot read the connection", async ({ page, browser }) => {
  const a = await createSoloTenant(world().runId, "v-accounting-a");
  const b = await createSoloTenant(world().runId, "v-accounting-b");
  await signIn(page, a.admin);
  for (const provider of ["sage", "quickbooks"]) {
    const start = await page.request.post(`/api/accounting/${provider}/connect`); expect(start.status()).toBe(200);
    const authorization = new URL((await start.json()).url);
    const realm = BigInt(`0x${a.id.replace(/-/g, "")}`).toString().slice(0, 18);
    const callback = await page.request.get(`/api/accounting/${provider}/callback`, { params: { code: `reviewer-${provider}-${a.id}`, state: authorization.searchParams.get("state")!, ...(provider === "quickbooks" ? { realmId: realm } : {}) }, maxRedirects: 0 });
    expect(callback.status()).toBe(303); expect(callback.headers().location).toContain("result=connected");
    const status = await page.request.get(`/api/accounting/${provider}/status`); expect(status.status()).toBe(200);
    expect(await status.json()).toEqual({ status: "connected", configured: true, tenantName: provider === "sage" ? "Example Sage business" : "Example QuickBooks business" });
  }
  const stored = await adminClient().from("integration_secrets").select("provider,access_token_enc,refresh_token_enc").eq("organization_id", a.id);
  expect(stored.error).toBeNull(); expect(stored.data).toHaveLength(2);
  const key = Buffer.from(process.env.REVIEWER_TEST_KEY!, "base64");
  for (const row of stored.data!) {
    for (const [field, purpose] of [["access_token_enc", "access"], ["refresh_token_enc", "refresh"]] as const) {
      expect(row[field]).toMatch(/^v1\./); expect(row[field]).not.toContain(`reviewer-${row.provider}`);
      expect(decryptSecret(row[field], { organizationId: a.id, provider: row.provider, purpose }, key)).toBe(`reviewer-${row.provider}-${purpose}-${a.id}`);
      expect(() => decryptSecret(row[field], { organizationId: b.id, provider: row.provider, purpose }, key)).toThrow();
      expect(() => decryptSecret(row[field], { organizationId: a.id, provider: row.provider === "sage" ? "quickbooks" : "sage", purpose }, key)).toThrow();
    }
  }
  const invoice = await adminClient().from("invoices").insert({ organization_id: a.id, invoice_ref: "REVIEWER-INV", customer: "Example Customer A", total: 120.50, subtotal: 120.50, vat: 0, amount_paid: 0, status: "sent" }).select("id").single(); expect(invoice.error).toBeNull();
  for (const [provider, outstandingPence] of [["sage", 2050], ["quickbooks", 4567]] as const) {
    const check = await page.request.post(`/api/accounting/${provider}/check`, { data: { invoiceId: invoice.data!.id } }); expect(check.status()).toBe(200);
    expect(await check.json()).toMatchObject({ reviewOnly: true, evidence: { totalPence: 12050, outstandingPence } });
  }
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await context.newPage(); await signIn(other, b.admin);
    for (const provider of ["sage", "quickbooks"]) {
      const status = await other.request.get(`/api/accounting/${provider}/status?organizationId=${a.id}`); expect(status.status()).toBe(200);
      expect(await status.json()).toEqual({ configured: true, status: "not_connected", tenantName: null });
      const foreign = await other.request.post(`/api/accounting/${provider}/check`, { data: { invoiceId: invoice.data!.id, organizationId: a.id } }); expect(foreign.status()).toBe(404);
    }
  } finally { await context.close(); }
  const unchanged = await adminClient().from("invoices").select("status,amount_paid").eq("id", invoice.data!.id).single();
  expect(unchanged.error).toBeNull(); expect(unchanged.data).toEqual({ status: "sent", amount_paid: 0 });
});
