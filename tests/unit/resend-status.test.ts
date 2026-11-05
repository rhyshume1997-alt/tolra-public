import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { checkResend, parseSender, resendConfigStatus } from "@/lib/email/resend-status";

const ENV = { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "Tolra <orders@mail.example.test>" };
const client = (answer: unknown) => ({ domains: { list: vi.fn(async () => answer as never) } });

describe("Resend configuration status", () => {
  it("not configured when nothing is set", () => expect(resendConfigStatus({}).state).toBe("not_configured"));
  it("error when only half is set, or the sender is not an address", () => {
    expect(resendConfigStatus({ RESEND_API_KEY: "k" }).state).toBe("error");
    expect(resendConfigStatus({ EMAIL_FROM: "a@b.test" }).state).toBe("error");
    expect(resendConfigStatus({ RESEND_API_KEY: "k", EMAIL_FROM: "not an address" }).state).toBe("error");
  });
  it("configured when both are set, and never returns the key", () => {
    const s = resendConfigStatus(ENV);
    expect(s).toMatchObject({ state: "configured", sender: "orders@mail.example.test" });
    expect(JSON.stringify(s)).not.toContain("re_test_key");
  });
  it("parses both sender forms and strips line breaks", () => {
    expect(parseSender("a@b.test")).toEqual({ address: "a@b.test", domain: "b.test" });
    expect(parseSender("Tolra <A@B.test>\r\nBcc: x@y.test")).toBeNull();
  });
});

describe("Resend live check (mocked answers)", () => {
  it("connected when the sender's domain is verified", async () => {
    expect((await checkResend(ENV, client({ data: { data: [{ name: "mail.example.test", status: "verified" }] }, error: null }))).state).toBe("connected");
  });
  it("a verified parent domain covers the sender", async () => {
    expect((await checkResend({ ...ENV, EMAIL_FROM: "a@mail.example.test" }, client({ data: { data: [{ name: "example.test", status: "verified" }] }, error: null }))).state).toBe("connected");
  });
  it("error when the domain is pending, failed or missing", async () => {
    for (const data of [[{ name: "mail.example.test", status: "pending" }], [{ name: "mail.example.test", status: "failed" }], [{ name: "other.test", status: "verified" }], []]) {
      expect((await checkResend(ENV, client({ data: { data }, error: null }))).state).toBe("error");
    }
  });
  it("error when Resend refuses the key (401/403)", async () => {
    const s = await checkResend(ENV, client({ data: null, error: { name: "invalid_api_key", statusCode: 401 } }));
    expect(s).toMatchObject({ state: "error" });
    expect(s.message).toMatch(/refused the API key/);
  });
  it("a send-only key stays configured (cannot list domains, can still send)", async () => {
    expect((await checkResend(ENV, client({ data: null, error: { name: "restricted_api_key", statusCode: 401 } }))).state).toBe("configured");
  });
  it("rate limited stays configured; a 500 or a thrown network error is an error", async () => {
    expect((await checkResend(ENV, client({ data: null, error: { name: "rate_limit_exceeded", statusCode: 429 } }))).state).toBe("configured");
    expect((await checkResend(ENV, client({ data: null, error: { name: "application_error", statusCode: 500 } }))).state).toBe("error");
    expect((await checkResend(ENV, { domains: { list: async () => { throw new Error("ECONNRESET"); } } })).state).toBe("error");
  });
  it("makes no call to Resend when it is not configured", async () => {
    const c = client({ data: { data: [] }, error: null });
    expect((await checkResend({}, c)).state).toBe("not_configured");
    expect(c.domains.list).not.toHaveBeenCalled();
  });
});

describe("sender settings must be one complete, unchanged address", () => {
  it.each(["Tolra <orders@example.test", "orders@example.test>", "Tolra\r\n<orders@example.test>", "Tolra\u2028<orders@example.test>", "Tolra\0<orders@example.test>"])("refuses malformed or header-control sender %j", value => {
    expect(parseSender(value)).toBeNull();
    expect(resendConfigStatus({ ...ENV, EMAIL_FROM: value }).state).toBe("error");
  });
});
