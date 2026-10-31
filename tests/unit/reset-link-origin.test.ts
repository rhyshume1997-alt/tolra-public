/**
 * Audit S1/C8: the password reset e-mail's link never comes from the request in production. Before, with NEXT_PUBLIC_SITE_URL unset
 * the link was built from the request's Origin (and sameOrigin accepts X-Forwarded-Host), so whoever asked for a reset could have the
 * person's reset token sent to a site of their choosing. Now production refuses (500, nothing sent) until the variable is set;
 * locally and in a preview the request's origin is still used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isProductionDeployment, setPasswordUrl } from "@/lib/auth-links";

vi.mock("server-only", () => ({}));

const resetCalls: Array<[string, { redirectTo?: string }]> = [];
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ rpc: async () => ({ data: true, error: null }) }) }));
vi.mock("@supabase/supabase-js", async (original) => {
  const real = await original<typeof import("@supabase/supabase-js")>();
  return { ...real, createClient: () => ({ auth: { resetPasswordForEmail: async (email: string, options: { redirectTo?: string }) => { resetCalls.push([email, options]); return { error: null }; } } }) };
});

const { POST: reset } = await import("@/app/api/auth/reset/route");

const ENV = ["NEXT_PUBLIC_SITE_URL", "VERCEL_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const evil = (identifier = "someone@example.test") =>
  new Request("https://app.tolra.test/api/auth/reset", {
    method: "POST",
    headers: { origin: "https://evil.example", host: "app.tolra.test", "x-forwarded-host": "evil.example", "x-real-ip": "203.0.113.7" },
    body: JSON.stringify({ identifier }),
  });

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  resetCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

describe("setPasswordUrl", () => {
  it("always uses NEXT_PUBLIC_SITE_URL when set, whatever the request says", () => {
    for (const VERCEL_ENV of ["production", "preview", undefined]) {
      expect(setPasswordUrl("https://evil.example", { NEXT_PUBLIC_SITE_URL: "https://app.tolra.co.uk/", VERCEL_ENV })).toBe("https://app.tolra.co.uk/auth/set-password");
    }
  });
  it("production without it: null (Vercel Production, or a production build outside Vercel), never the request's origin", () => {
    expect(setPasswordUrl("https://evil.example", { VERCEL_ENV: "production" })).toBeNull();
    expect(setPasswordUrl("https://evil.example", { NODE_ENV: "production" })).toBeNull();
    expect(setPasswordUrl("https://evil.example", { VERCEL_ENV: "production", NEXT_PUBLIC_SITE_URL: "" })).toBeNull();
  });
  it("local development and a Vercel Preview keep today's fallback to the request's origin", () => {
    expect(setPasswordUrl("http://localhost:3000", { NODE_ENV: "development" })).toBe("http://localhost:3000/auth/set-password");
    expect(setPasswordUrl("https://tolra-git-x.vercel.app", { VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("https://tolra-git-x.vercel.app/auth/set-password");
  });
  it("isProductionDeployment: VERCEL_ENV decides on Vercel; NODE_ENV only outside it", () => {
    expect(isProductionDeployment({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(false);
    expect(isProductionDeployment({ VERCEL_ENV: "development", NODE_ENV: "production" })).toBe(false);
    expect(isProductionDeployment({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ NODE_ENV: "test" })).toBe(false);
    expect(isProductionDeployment({})).toBe(false);
  });
});

describe("POST /api/auth/reset: the link in the e-mail", () => {
  it("production with NEXT_PUBLIC_SITE_URL unset: 500 with a generic message and a server log, nothing sent, for any identifier", async () => {
    process.env.VERCEL_ENV = "production";
    for (const identifier of ["someone@example.test", "nobody@example.test"]) {
      const response = await reset(evil(identifier));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Password reset is unavailable right now. Contact your administrator." });
    }
    expect(resetCalls).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("NEXT_PUBLIC_SITE_URL is not set"));
  });

  it("production with NEXT_PUBLIC_SITE_URL set: the link points at it, not at the Origin or X-Forwarded-Host sent", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_SITE_URL = "https://app.tolra.co.uk";
    const response = await reset(evil());
    expect(response.status).toBe(200);
    expect(resetCalls).toEqual([["someone@example.test", { redirectTo: "https://app.tolra.co.uk/auth/set-password" }]]);
  });

  it("outside production (tests, local, preview) the request's origin is still the fallback", async () => {
    process.env.VERCEL_ENV = "preview";
    const response = await reset(new Request("https://tolra-git-x.vercel.app/api/auth/reset", { method: "POST", headers: { "x-real-ip": "203.0.113.8" }, body: JSON.stringify({ identifier: "someone@example.test" }) }));
    expect(response.status).toBe(200);
    expect(resetCalls[0][1]).toEqual({ redirectTo: "https://tolra-git-x.vercel.app/auth/set-password" });
  });
});
