/**
 * Finding S4-F1: browser-reported errors (POST /api/report-error, any signed-in person) have their own, smaller e-mail budget, so they
 * can't use up the day's server and cron alerts. The route passes the person and company, still logs when the budget is spent, sends no
 * e-mail then, and answers 200 exactly as before. While migration 115 is not applied it falls back to the old function. The Supabase
 * admin client is a stand-in that records every rpc; the database side is proved in tests/scripts/browser-error-alert-115.proof.sql.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

const USER = "11111111-2222-4333-8444-555555555555";
const sent: Array<{ text: string }> = [];
const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
let answer: (name: string, args: Record<string, unknown>) => { data: unknown; error: { code: string } | null };

vi.mock("@/lib/resend", () => ({ resend: { emails: { send: async (payload: { text: string }) => { sent.push({ text: payload.text }); return { error: null }; } } } }));
vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { rpcs.push({ name, args }); return answer(name, args); } }),
}));
const chain = (result: unknown) => {
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve({ data: result, error: null }) : () => c) });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER, email: "someone@example.test" } }, error: null }) },
    from: () => chain({ id: USER, email: "someone@example.test", full_name: "S", role: "workshop", secondary_role: null, organization_id: "org-7", active: true, must_change_password: false }),
    rpc: async (name: string) => (name === "current_user_organization_id" ? { data: "org-7", error: null } : { data: null, error: null }),
  }),
}));

import { POST as reportError } from "@/app/api/report-error/route";
import { reportServerError } from "@/lib/server/error-alert";

const ENV = ["REQUIRE_ADMIN_MFA", "ALERT_EMAIL_TO", "EMAIL_FROM", "VERCEL_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const word = (i: number, prefix: string) => `${prefix} ${WORDS[i - 1]}`; // fingerprints collapse digits, so distinct errors need distinct words
const report = (message: string) => reportError(new Request("https://app.test/api/report-error", { method: "POST", body: JSON.stringify({ message, path: "/jobs" }) }));
const claimNames = () => rpcs.map((r) => r.name);
let logged: unknown[][];

/** A stand-in for 115's function: 5 e-mails a person, remembered per person; and 033's, which counts server alerts only (20). */
function database() {
  const perUser = new Map<string, number>();
  let server = 0;
  const seen = new Set<string>();
  return (name: string, args: Record<string, unknown>) => {
    if (name === "claim_browser_error_alert") {
      const fp = String(args.p_fingerprint);
      const user = String(args.p_user_id);
      if (seen.has(fp)) return { data: false, error: null };
      if ((perUser.get(user) ?? 0) >= 5) return { data: false, error: null };
      seen.add(fp);
      perUser.set(user, (perUser.get(user) ?? 0) + 1);
      return { data: true, error: null };
    }
    if (name === "claim_error_alert") {
      server += 1;
      return { data: server <= 20, error: null };
    }
    return { data: null, error: { code: "PGRST202" } };
  };
}

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", REQUIRE_ADMIN_MFA: "false",
    ALERT_EMAIL_TO: "owner@example.test", EMAIL_FROM: "Tolra <alerts@example.test>", VERCEL_ENV: "production",
  });
  sent.length = 0;
  rpcs.length = 0;
  answer = database();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args); });
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

describe("POST /api/report-error and the browser alert budget (S4-F1)", () => {
  it("claims with the browser function, passing the fingerprint, the signed-in person and their company; never the shared function", async () => {
    const response = await report("TypeError one");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(claimNames()).toEqual(["claim_browser_error_alert"]);
    expect(rpcs[0].args).toMatchObject({ p_user_id: USER, p_company_id: "org-7" });
    expect(String(rpcs[0].args.p_fingerprint)).toMatch(/^[0-9a-f]{12}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Source:      browser");
  });

  it("the person's sixth different report in a day: logged, no e-mail, and the answer is the same 200 {ok:true}", async () => {
    const answers: Array<{ status: number; body: unknown }> = [];
    for (let i = 1; i <= 8; i += 1) {
      const response = await report(word(i, "distinct failure"));
      answers.push({ status: response.status, body: await response.json() });
    }
    expect(sent).toHaveLength(5);
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify({ status: 200, body: { ok: true } })]));
    // Every report is logged, e-mailed or not, redacted.
    expect(logged.filter((l) => l[0] === "[report-error]")).toHaveLength(8);
    expect(JSON.stringify(logged)).not.toMatch(/someone@example|11111111-2222/);
  });

  it("a spent browser budget leaves the server alerts alone: a server alert still claims and sends", async () => {
    for (let i = 1; i <= 7; i += 1) await report(word(i, "browser failure"));
    expect(sent).toHaveLength(5);
    const result = await reportServerError({ route: "GET /api/cron/x", error: new Error("cron failed") });
    expect(result).toEqual({ sent: true, reason: "sent" });
    expect(claimNames().filter((n) => n === "claim_error_alert")).toHaveLength(1);
    expect(rpcs.filter((r) => r.name === "claim_error_alert").every((r) => !("p_user_id" in r.args))).toBe(true);
    expect(sent).toHaveLength(6);
  });

  it("while migration 115 is not applied (function missing) it falls back to the old shared function", async () => {
    answer = (name) => (name === "claim_browser_error_alert" ? { data: null, error: { code: "PGRST202" } } : { data: true, error: null });
    expect((await report("before 115 one")).status).toBe(200);
    expect(claimNames()).toEqual(["claim_browser_error_alert", "claim_error_alert"]);
    expect(sent).toHaveLength(1);
    // Postgres' own code for a missing function is treated the same.
    rpcs.length = 0;
    answer = (name) => (name === "claim_browser_error_alert" ? { data: null, error: { code: "42883" } } : { data: false, error: null });
    expect((await report("before 115 two")).status).toBe(200);
    expect(claimNames()).toEqual(["claim_browser_error_alert", "claim_error_alert"]);
    expect(sent).toHaveLength(1); // the old function said no
  });

  it("any other database error: the browser's own in-memory budget (5), which never touches the server's in-memory budget", async () => {
    answer = () => ({ data: null, error: { code: "XX000" } });
    for (let i = 1; i <= 8; i += 1) expect((await report(word(i, "db down failure"))).status).toBe(200);
    expect(sent).toHaveLength(5);
    expect(claimNames().every((n) => n === "claim_browser_error_alert")).toBe(true); // no fallback to the shared function on a real error
    const server = await reportServerError({ route: "GET /api/x", error: new Error("server while db down") });
    expect(server.sent).toBe(true);
  });

  it("a server alert never passes a person or company, and is unchanged", async () => {
    const result = await reportServerError({ route: "GET /api/y", error: new Error("plain server failure") });
    expect(result.sent).toBe(true);
    expect(rpcs).toEqual([{ name: "claim_error_alert", args: { p_fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) } }]);
  });
});
