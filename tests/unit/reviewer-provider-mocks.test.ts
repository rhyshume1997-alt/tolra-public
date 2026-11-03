import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const { mockResponse, realm } = createRequire(import.meta.url)("../support/reviewer-provider-mocks.cjs") as { mockResponse: (url: string, init?: RequestInit) => Response | null; realm: (org: string) => string };
const org = "11111111-1111-4111-8111-111111111111";
describe("local reviewer provider fakes do not hide cross-provider/tenant mistakes", () => {
  it("uses synthetic codes only and refuses the wrong provider", async () => {
    const body = new URLSearchParams({ code: `reviewer-sage-${org}` });
    expect(mockResponse("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { body })?.status).toBe(401);
    expect(await mockResponse("https://oauth.accounting.sage.com/token", { body })?.json()).toMatchObject({ access_token: `reviewer-sage-access-${org}` });
    expect(mockResponse("https://oauth.accounting.sage.com/token", { body: "code=real-looking-code" })?.status).toBe(400);
  });
  it("refuses a mixed provider or tenant instead of returning a canned success", () => {
    expect(mockResponse("https://api.accounting.sage.com/v3.1/sales_invoices", { headers: { authorization: `Bearer reviewer-quickbooks-access-${org}`, "X-Business": `reviewer-sage-${org}` } })?.status).toBe(401);
    expect(mockResponse("https://api.accounting.sage.com/v3.1/sales_invoices", { headers: { authorization: `Bearer reviewer-sage-access-${org}`, "X-Business": "other-company" } })?.status).toBe(403);
    expect(mockResponse(`https://sandbox-quickbooks.api.intuit.com/v3/company/${realm(org)}/query`, { headers: { authorization: `Bearer reviewer-quickbooks-access-${org}` } })?.status).toBe(200);
  });
  it("refuses provider document writes rather than masking a read-only regression", () => {
    expect(mockResponse("https://api.accounting.sage.com/v3.1/sales_invoices", { method: "POST", headers: { authorization: `Bearer reviewer-sage-access-${org}`, "X-Business": `reviewer-sage-${org}` } })?.status).toBe(405);
  });
  it("leaves ordinary requests to the existing network guard", () => {
    expect(mockResponse("https://unrelated.example/anything")).toBeNull();
  });
});
