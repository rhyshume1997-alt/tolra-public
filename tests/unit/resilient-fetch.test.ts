import { describe, expect, it } from "vitest";

import { isRetrySafe, withGatewayRetry } from "@/lib/server/resilient-fetch";

function fakeFetch(statuses: number[]) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response("{}", { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("gateway retry for server Supabase clients", () => {
  it("retries a safe request once after a 502", async () => {
    const { fn, calls } = fakeFetch([502, 200]);
    const res = await withGatewayRetry(fn, 0)("http://x/rest/v1/rpc/current_user_organization_id", { method: "POST" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("never retries an insert or an unlisted RPC", async () => {
    for (const [url, method] of [["http://x/rest/v1/customers", "POST"], ["http://x/rest/v1/rpc/create_with_lines", "POST"], ["http://x/rest/v1/rpc/convert_sales_order", "POST"]]) {
      const { fn, calls } = fakeFetch([502, 200]);
      expect((await withGatewayRetry(fn, 0)(url, { method })).status).toBe(502);
      expect(calls).toHaveLength(1);
    }
  });

  it("retries only once, and not on ordinary errors", async () => {
    const twice = fakeFetch([502, 502, 200]);
    expect((await withGatewayRetry(twice.fn, 0)("http://x/rest/v1/jobs", { method: "GET" })).status).toBe(502);
    expect(twice.calls).toHaveLength(2);
    const denied = fakeFetch([403, 200]);
    expect((await withGatewayRetry(denied.fn, 0)("http://x/rest/v1/jobs", { method: "PATCH" })).status).toBe(403);
    expect(denied.calls).toHaveLength(1);
  });

  it("classifies methods", () => {
    expect(isRetrySafe("http://x/rest/v1/email_history?id=eq.1", "PATCH")).toBe(true);
    expect(isRetrySafe("http://x/rest/v1/email_history", "POST")).toBe(false);
  });
});

describe("the session reads in every API guard are retried (go-live polish item 15)", () => {
  it("my_session and company_people are read-only and retried once on a gateway 502", async () => {
    expect(isRetrySafe("http://x/rest/v1/rpc/my_session", "POST")).toBe(true);
    expect(isRetrySafe("http://x/rest/v1/rpc/company_people", "POST")).toBe(true);
    let calls = 0;
    const flaky = (async () => new Response(calls++ === 0 ? "bad gateway" : "{}", { status: calls === 1 ? 502 : 200 })) as unknown as typeof fetch;
    const response = await withGatewayRetry(flaky, 0)("http://x/rest/v1/rpc/my_session", { method: "POST" });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });
});
