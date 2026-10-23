/**
 * Production error alerts: redaction (no ids, e-mail addresses, tokens), the rate limits (one per fingerprint per hour, 20 a
 * day), off unless ALERT_EMAIL_TO is set, and the admin-only test trigger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

const sent: Array<{ payload: { from: string; to: string[]; subject: string; text: string }; options: Record<string, unknown> }> = [];
let claimAnswer: () => Promise<{ data?: unknown; error?: { code: string } | null }>;
let sendAnswer: () => Promise<{ error?: { name: string } | null }>;
let who: { role: string };

vi.mock("@/lib/resend", () => ({
  resend: { emails: { send: async (payload: never, options: never) => { sent.push({ payload, options }); return sendAnswer(); } } },
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ rpc: async () => claimAnswer() }) }));
const chain = (result: unknown) => {
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve({ data: result, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "11111111-2222-4333-8444-555555555555", email: "rhys.private@example.test" } }, error: null }) },
    from: () => chain({ id: "11111111-2222-4333-8444-555555555555", email: "rhys.private@example.test", full_name: "R", role: who.role, secondary_role: null, organization_id: "org-1", active: true, must_change_password: false }),
    rpc: async (name: string, args: { allowed_roles?: string[] }) => (name === "current_user_organization_id" ? { data: "org-1", error: null } : name === "has_org_role" ? { data: (args.allowed_roles ?? []).includes(who.role), error: null } : name === "admin_mfa_overview" ? { data: { require_admin_mfa: false, can_require: true, admins: [] }, error: null } : { data: null, error: null }),
  }),
}));

import { POST as alertTest } from "@/app/api/admin/alert-test/route";
import { POST as reportError } from "@/app/api/report-error/route";
import { ALERT_MAX_PER_DAY, ALERT_PER_FINGERPRINT_MS, alertEmail, createAlertBudget, fingerprint, redact, safeRoute } from "@/lib/error-alert";
import { alertsEnabled, reportServerError } from "@/lib/server/error-alert";

const ENV = ["REQUIRE_ADMIN_MFA", "ALERT_EMAIL_TO", "EMAIL_FROM", "VERCEL_ENV", "VERCEL_GIT_COMMIT_SHA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
const post = (url: string, body: unknown = {}) => new Request(`https://app.test${url}`, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  sent.length = 0;
  claimAnswer = async () => ({ data: true, error: null });
  sendAnswer = async () => ({ error: null });
  who = { role: "admin" };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

const on = () => Object.assign(process.env, { REQUIRE_ADMIN_MFA: "false", ALERT_EMAIL_TO: "rhys@example.test", EMAIL_FROM: "Tolra <alerts@example.test>", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123" });

describe("redact", () => {
  it("removes UUIDs, e-mail addresses, tokens, keys, bearer values and long numbers", () => {
    const text = redact("duplicate key for 7b0f4a3c-1d2e-4c5b-8f6a-123456789abc owner jane.doe+x@customer.example.co.uk token=abc123secret Bearer abcdefgh12345678 key: sk_live_ABCDEFGH ring 07700 900123 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl");
    expect(text).not.toMatch(/7b0f4a3c|jane\.doe|customer\.example|abc123secret|abcdefgh12345678|sk_live|07700|eyJ/);
    expect(text).toContain("[id]");
    expect(text).toContain("[email]");
    expect(text).toContain("[secret]");
    expect(text).toContain("[token]");
    expect(text).toContain("[number]");
    expect(text).toContain("duplicate key for");
  });

  it("accepts an Error or anything else, collapses whitespace and cuts long messages", () => {
    expect(redact(new Error("boom\n  at x"))).toBe("boom at x");
    expect(redact(undefined)).toBe("");
    expect(redact({ not: "text" })).toBe("");
    const long = redact("x ".repeat(500));
    expect(long.length).toBeLessThanOrEqual(303);
    expect(long.endsWith("...")).toBe(true);
  });

  it("route paths lose ids, long tokens and the query", () => {
    expect(safeRoute("GET /jobs/7b0f4a3c-1d2e-4c5b-8f6a-123456789abc/print?token=abc#x")).toBe("GET /jobs/[id]/print");
    expect(safeRoute("/customers/12345678")).toBe("/customers/[n]");
    expect(safeRoute("/a/" + "z".repeat(40))).toBe("/a/[token]");
    expect(safeRoute(undefined)).toBe("unknown");
  });
});

describe("fingerprint", () => {
  it("is stable for the same error, ignores ids and numbers, and differs by route or message", async () => {
    const a = await fingerprint("GET /jobs/7b0f4a3c-1d2e-4c5b-8f6a-123456789abc", "Job J-0042 not found for 7b0f4a3c-1d2e-4c5b-8f6a-123456789abc");
    const b = await fingerprint("GET /jobs/99999999-1d2e-4c5b-8f6a-123456789abc", "Job J-0043 not found for 99999999-1d2e-4c5b-8f6a-123456789abc");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
    expect(await fingerprint("GET /quotes", "Job J-0042 not found")).not.toBe(await fingerprint("GET /jobs", "Job J-0042 not found"));
    expect(await fingerprint("GET /jobs", "Job not found")).not.toBe(await fingerprint("GET /jobs", "Job exploded"));
  });
});

describe("rate limits (in-memory budget, the same rules as the database's)", () => {
  it("one e-mail per fingerprint per hour", () => {
    const budget = createAlertBudget();
    const t = 1_000_000;
    expect(budget.claim("aaaaaaaaaaaa", t)).toBe(true);
    expect(budget.claim("aaaaaaaaaaaa", t + 1000)).toBe(false);
    expect(budget.claim("aaaaaaaaaaaa", t + ALERT_PER_FINGERPRINT_MS - 1)).toBe(false);
    expect(budget.claim("bbbbbbbbbbbb", t + 1000)).toBe(true);
    expect(budget.claim("aaaaaaaaaaaa", t + ALERT_PER_FINGERPRINT_MS + 1)).toBe(true);
  });

  it("20 a day, then again once the day has passed", () => {
    const budget = createAlertBudget();
    const t = 5_000_000;
    for (let i = 0; i < ALERT_MAX_PER_DAY; i += 1) expect(budget.claim(`fp${String(i).padStart(10, "0")}`, t + i)).toBe(true);
    expect(budget.claim("ffffffffffff", t + 100)).toBe(false);
    expect(budget.claim("ffffffffffff", t + 25 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("the alert e-mail", () => {
  it("has only the agreed fields", () => {
    const mail = alertEmail({ route: "GET /jobs", message: "boom", fingerprint: "0123456789ab", commit: "0123456789ab", environment: "production", at: "2026-10-12T09:00:00.000Z", source: "server" });
    expect(mail.subject).toBe("[Tolra alert] GET /jobs (0123456789ab)");
    expect(mail.text).toContain("Route:       GET /jobs");
    expect(mail.text).toContain("Fingerprint: 0123456789ab");
    expect(mail.text).toContain("Deployed:    0123456789ab");
  });
});

describe("reportServerError", () => {
  it("is off unless ALERT_EMAIL_TO is set, and sends nothing", async () => {
    Object.assign(process.env, { EMAIL_FROM: "Tolra <alerts@example.test>", VERCEL_ENV: "production" });
    expect(alertsEnabled()).toBe(false);
    expect(await reportServerError({ route: "GET /x", error: new Error("boom") })).toEqual({ sent: false, reason: "disabled" });
    expect(sent).toEqual([]);
  });

  it("never sends from a preview or development deployment, even with the address set", async () => {
    on();
    process.env.VERCEL_ENV = "preview";
    expect(alertsEnabled()).toBe(false);
    expect(await reportServerError({ route: "GET /x", error: new Error("boom") })).toEqual({ sent: false, reason: "not-production" });
    expect(sent).toEqual([]);
    delete process.env.VERCEL_ENV; // local / self-hosted: the variable being set is the switch
    expect(alertsEnabled()).toBe(true);
  });

  it("one simulated failure: one sanitised e-mail to the owner with route, commit, time and fingerprint", async () => {
    on();
    const result = await reportServerError({ route: "GET /jobs/7b0f4a3c-1d2e-4c5b-8f6a-123456789abc?x=1", error: new Error("Cannot read x for jane@customer.example (7b0f4a3c-1d2e-4c5b-8f6a-123456789abc)") });
    expect(result).toEqual({ sent: true, reason: "sent" });
    expect(sent).toHaveLength(1);
    const { payload } = sent[0];
    expect(payload.to).toEqual(["rhys@example.test"]);
    expect(payload.from).toBe("Tolra <alerts@example.test>");
    expect(payload.text).toContain("Route:       GET /jobs/[id]");
    expect(payload.text).toContain("Deployed:    0123456789ab");
    expect(payload.text).toMatch(/Fingerprint: [0-9a-f]{12}/);
    expect(payload.text).toMatch(/Time \(UTC\):  \d{4}-\d{2}-\d{2}T/);
    expect(payload.text + payload.subject).not.toMatch(/jane@|customer\.example|7b0f4a3c|x=1/);
  });

  it("when the budget says no, nothing is sent", async () => {
    on();
    claimAnswer = async () => ({ data: false, error: null });
    expect(await reportServerError({ route: "GET /x", error: new Error("boom") })).toEqual({ sent: false, reason: "rate-limited" });
    expect(sent).toEqual([]);
  });

  it("if the database can't be asked, the in-memory budget still lets the first one through and stops repeats", async () => {
    on();
    claimAnswer = async () => ({ data: null, error: { code: "XX000" } });
    expect((await reportServerError({ route: "GET /repeat", error: new Error("db down") })).sent).toBe(true);
    expect((await reportServerError({ route: "GET /repeat", error: new Error("db down") })).reason).toBe("rate-limited");
    expect(sent).toHaveLength(1);
  });

  it("a failing provider or a thrown error is reported as not sent, and never throws", async () => {
    on();
    sendAnswer = async () => ({ error: { name: "validation_error" } });
    expect(await reportServerError({ route: "GET /a", error: new Error("one") })).toEqual({ sent: false, reason: "send-failed" });
    sendAnswer = async () => { throw new Error("ECONNRESET"); };
    expect((await reportServerError({ route: "GET /b", error: new Error("two") })).sent).toBe(false);
  });
});

describe("the test trigger and the browser report", () => {
  it("POST /api/admin/alert-test: an admin gets one e-mail that shows the redaction; the second within the hour is rate limited", async () => {
    on();
    const memory = createAlertBudget();
    claimAnswer = async () => ({ data: memory.claim("budget-stand-in"), error: null });
    const first = await alertTest(post("/api/admin/alert-test"));
    expect(await first.json()).toEqual({ sent: true, reason: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.text).toContain("Simulated production failure (alert test)");
    expect(sent[0].payload.text).not.toMatch(/rhys\.private|11111111-2222/);
    expect(sent[0].payload.text).toContain("[email]");
    expect(sent[0].payload.text).toContain("[id]");
    expect(await (await alertTest(post("/api/admin/alert-test"))).json()).toEqual({ sent: false, reason: "rate-limited" });
    expect(sent).toHaveLength(1);
  });

  it("says why when alerts are off, and refuses everyone but an admin", async () => {
    expect(await (await alertTest(post("/api/admin/alert-test"))).json()).toMatchObject({ sent: false, reason: "disabled" });
    on();
    who = { role: "office" };
    expect((await alertTest(post("/api/admin/alert-test"))).status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("POST /api/report-error: a signed-in browser report is redacted and sent as 'browser'; the answer never says whether an e-mail went", async () => {
    on();
    who = { role: "workshop" };
    const response = await reportError(post("/api/report-error", { message: "TypeError for jane@customer.example", digest: "d123", path: "/jobs/7b0f4a3c-1d2e-4c5b-8f6a-123456789abc" }));
    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.text).toContain("Source:      browser");
    expect(sent[0].payload.text).not.toMatch(/jane@|7b0f4a3c/);
  });
});
