// Portal per-IP limits: exact numbers, hashed IP, fail closed.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => null }));

import { PORTAL_LIMITS, checkPortalIpLimit } from "@/lib/portal/limits";

const req = (ip = "203.0.113.9") => new Request("https://x.test/api/portal", { headers: { "x-real-ip": ip } });
const adminWith = (rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>) => ({ rpc }) as never;

describe("portal per-IP limits", () => {
  it("has the proposed numbers: request 10, verify 20, read 300, each per 15 minutes", () => {
    expect(PORTAL_LIMITS.request).toMatchObject({ windowSeconds: 900, max: 10 });
    expect(PORTAL_LIMITS.verify).toMatchObject({ windowSeconds: 900, max: 20 });
    expect(PORTAL_LIMITS.read).toMatchObject({ windowSeconds: 900, max: 300 });
    for (const l of Object.values(PORTAL_LIMITS)) expect(l.bucket).toMatch(/^[a-z_:]{1,40}$/);
  });
  it("passes the exact bucket, window and max to auth_rate_hit, with a hashed IP", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const admin = adminWith(async (fn, args) => { calls.push({ fn, args }); return { data: true, error: null }; });
    for (const step of ["request", "verify", "read"] as const) expect(await checkPortalIpLimit(step, req(), admin)).toBe("ok");
    expect(calls.map((c) => [c.args.p_bucket, c.args.p_window_seconds, c.args.p_max])).toEqual([["portal_ip_request", 900, 10], ["portal_ip_verify", 900, 20], ["portal_ip_read", 900, 300]]);
    for (const c of calls) {
      expect(c.fn).toBe("auth_rate_hit");
      expect(c.args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(c.args)).not.toContain("203.0.113.9");
    }
  });
  it("different IPs use different keys", async () => {
    const keys: unknown[] = [];
    const admin = adminWith(async (_fn, args) => { keys.push(args.p_key_hash); return { data: true, error: null }; });
    await checkPortalIpLimit("request", req("198.51.100.1"), admin);
    await checkPortalIpLimit("request", req("198.51.100.2"), admin);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("says limited when the database says over the limit", async () => {
    expect(await checkPortalIpLimit("request", req(), adminWith(async () => ({ data: false, error: null })))).toBe("limited");
  });
  it("fails closed: no client, an error, or a throw is 'unavailable', never 'ok'", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPortalIpLimit("verify", req(), null)).toBe("unavailable");
    expect(await checkPortalIpLimit("verify", req(), adminWith(async () => ({ data: null, error: { code: "XX" } })))).toBe("unavailable");
    expect(await checkPortalIpLimit("verify", req(), adminWith(async () => { throw new Error("down"); }))).toBe("unavailable");
    expect(await checkPortalIpLimit("verify", req(), adminWith(async () => ({ data: "yes", error: null })))).toBe("limited");
    quiet.mockRestore();
  });
});
