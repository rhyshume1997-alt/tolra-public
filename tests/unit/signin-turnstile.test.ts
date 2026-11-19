/**
 * Turnstile on sign-in (audit F1). Off by default: no site key = no widget, no token sent, default CSP unchanged. With a token the
 * route hands it to Supabase (which enforces it); a captcha refusal is its own answer and is never counted as a failed guess.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifySignInResponse } from "@/lib/auth-errors";
import { CAPTCHA_REQUIRED_MESSAGE, cleanCaptchaToken, isCaptchaError, turnstileSiteKey } from "@/lib/auth/turnstile";

let signInArgs: unknown;
let signInError: unknown;
const failureWrites: string[] = [];

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => ({
    rpc: async (_name: string, args: { p_bucket?: string }) => { if (args?.p_bucket?.startsWith("signin_fail")) failureWrites.push(args.p_bucket); return { data: true, error: null }; },
    from: () => ({
      select: (_c: string, opts?: { head?: boolean }) => {
        const chain: unknown = new Proxy({}, { get: (_, prop) => {
          if (prop === "then") return opts?.head ? (resolve: (v: unknown) => void) => resolve({ count: 0, error: null }) : undefined;
          if (prop === "maybeSingle") return async () => ({ data: { email: "office@example.test" }, error: null });
          return () => chain;
        } });
        return chain;
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { signInWithPassword: async (args: unknown) => {
    signInArgs = args;
    return signInError ? { data: { user: null }, error: signInError } : { data: { user: { id: "u-1" } }, error: null };
  } } }),
}));

import { POST as signIn } from "@/app/api/auth/signin/route";

const post = (extra: Record<string, unknown> = {}) => new Request("https://app.test/api/auth/signin", {
  method: "POST", body: JSON.stringify({ identifier: "office_user", password: "Right-pass-9", ...extra }), headers: { "x-real-ip": "203.0.113.9" },
});

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  signInArgs = undefined; signInError = null; failureWrites.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("turnstile helpers", () => {
  it("is off without a site key", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    expect(turnstileSiteKey()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", " 0x4AAA ");
    expect(turnstileSiteKey()).toBe("0x4AAA");
  });
  it("accepts only a short, non-empty string token", () => {
    expect(cleanCaptchaToken("abc")).toBe("abc");
    expect(cleanCaptchaToken("  ")).toBeUndefined();
    expect(cleanCaptchaToken(42)).toBeUndefined();
    expect(cleanCaptchaToken("x".repeat(2049))).toBeUndefined();
  });
  it("recognises Supabase's captcha refusal and nothing else", () => {
    expect(isCaptchaError({ code: "captcha_failed", message: "x" })).toBe(true);
    expect(isCaptchaError({ message: "captcha verification process failed" })).toBe(true);
    expect(isCaptchaError({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe(false);
    expect(isCaptchaError(null)).toBe(false);
  });
  it("the screen shows the captcha message, not 'invalid password'", () => {
    expect(classifySignInResponse(400, CAPTCHA_REQUIRED_MESSAGE, true)).toEqual({ kind: "captcha", message: CAPTCHA_REQUIRED_MESSAGE });
    expect(classifySignInResponse(401, "Invalid username or password")).toEqual({ kind: "invalid" });
  });
});

describe("POST /api/auth/signin with Turnstile", () => {
  it("passes the token to Supabase", async () => {
    const res = await signIn(post({ captchaToken: "tok-1" }));
    expect(res.status).toBe(200);
    expect(signInArgs).toMatchObject({ password: "Right-pass-9", options: { captchaToken: "tok-1" } });
  });
  it("sends no options when there is no token (check off: behaviour unchanged)", async () => {
    await signIn(post());
    expect(signInArgs).not.toHaveProperty("options");
    await signIn(post({ captchaToken: "" }));
    expect(signInArgs).not.toHaveProperty("options");
  });
  it("a captcha refusal is its own 400 and is not counted as a failed guess", async () => {
    signInError = { name: "AuthApiError", status: 400, code: "captcha_failed", message: "captcha verification process failed" };
    const res = await signIn(post({ captchaToken: "stale" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CAPTCHA_REQUIRED_MESSAGE, captcha: true });
    expect(failureWrites).toEqual([]);
  });
  it("a wrong password still gets the identical 401 and is counted", async () => {
    signInError = { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" };
    const res = await signIn(post({ captchaToken: "tok-1" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid username or password" });
    expect(failureWrites.length).toBe(2);
  });
});

describe("CSP", () => {
  async function csp(key: string) {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", key);
    const config = (await import("../../next.config.mjs")).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const rule = (await config.headers()).find((r) => r.source === "/(.*)")!;
    return rule.headers.find((h) => h.key === "Content-Security-Policy")!.value;
  }
  it("allows Cloudflare only when the site key is set", async () => {
    expect(await csp("")).not.toContain("cloudflare");
    const on = await csp("0x4AAA");
    expect(on).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com");
    expect(on).toContain("frame-src https://challenges.cloudflare.com");
    expect(on).toContain("connect-src 'self' https://abcdefgh.supabase.co wss://abcdefgh.supabase.co https://challenges.cloudflare.com");
  });
});
