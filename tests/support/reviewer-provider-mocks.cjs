/* Loaded ONLY by the optional local reviewer runner, after no-network.cjs. Never imported by application code. */
"use strict";
function realm(org) { return BigInt(`0x${org.replace(/-/g, "")}`).toString().slice(0, 18); }
function mockResponse(input, init = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  const headers = new Headers(init.headers);
  if (["oauth.accounting.sage.com", "oauth.platform.intuit.com"].includes(url.hostname)) {
    const grant = new URLSearchParams(String(init.body));
    const match = /^reviewer-(sage|quickbooks)-([a-f0-9-]{36})$/.exec(grant.get("code") ?? "");
    if (!match) return Response.json({ error: "synthetic code refused" }, { status: 400 });
    const provider = url.hostname.includes("sage") ? "sage" : "quickbooks";
    if (match[1] !== provider) return Response.json({}, { status: 401 });
    return Response.json({ access_token: `reviewer-${provider}-access-${match[2]}`, refresh_token: `reviewer-${provider}-refresh-${match[2]}`, expires_in: 3600 });
  }
  if (!["api.accounting.sage.com", "sandbox-quickbooks.api.intuit.com"].includes(url.hostname)) return null;
  if ((init.method ?? "GET") !== "GET") return Response.json({ error: "reviewer data reads only" }, { status: 405 });
  const match = /^Bearer reviewer-(sage|quickbooks)-access-([a-f0-9-]{36})$/.exec(headers.get("authorization") ?? "");
  if (!match) return Response.json({}, { status: 401 });
  const [, provider, org] = match;
  if (url.hostname === "api.accounting.sage.com") {
    if (provider !== "sage") return Response.json({}, { status: 401 });
    if (url.pathname.endsWith("/businesses")) return Response.json({ $items: [{ id: `reviewer-sage-${org}`, name: "Example Sage business" }] });
    if (url.pathname.endsWith("/sales_invoices") && headers.get("X-Business") === `reviewer-sage-${org}`) return Response.json({ $items: [{ invoice_number: "REVIEWER-INV", total_amount: "120.50", outstanding_amount: "20.50", currency: { id: "GBP" } }] });
  } else if (provider === "quickbooks" && url.pathname.startsWith(`/v3/company/${realm(org)}/`)) {
    if (url.pathname.includes("/companyinfo/")) return Response.json({ CompanyInfo: { Id: "1", CompanyName: "Example QuickBooks business" } });
    if (url.pathname.endsWith("/query")) return Response.json({ QueryResponse: { Invoice: [{ DocNumber: "REVIEWER-INV", TotalAmt: 120.50, Balance: 45.67, CurrencyRef: { value: "GBP" } }] } });
  }
  return Response.json({ error: "synthetic provider/tenant mismatch" }, { status: 403 });
}
function install() {
  const backend = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname)) throw new Error("Reviewer mocks require the isolated loopback backend");
  const original = globalThis.fetch;
  globalThis.fetch = async function reviewerFetch(input, init) {
    const response = mockResponse(input, init);
    if (response) return response;
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname === "/emails" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (JSON.stringify(body.to).includes("reviewer-uncertain")) {
        // The local mock receives it once, but the caller cannot know delivery succeeded.
        const sent = await original(input, init); await sent.arrayBuffer();
        return Response.json({ message: "synthetic unknown delivery" }, { status: 500 });
      }
      if (String(body.subject).includes("reviewer-double")) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return original(input, init); // existing outbound guard still rejects all real external connections
  };
}
module.exports = { mockResponse, realm };
if (process.env.REVIEWER_LOCAL_MOCKS === "1") install();
