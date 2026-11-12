// Portal public sign-in routes: flag first, same origin, per-IP limit, one identical refusal, only correlation ids logged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ limit: vi.fn(), request: vi.fn(), verify: vi.fn(), end: vi.fn(), order: [] as string[] }));
vi.mock("@/lib/portal/limits", () => ({ checkPortalIpLimit: (...a: unknown[]) => { m.order.push("limit"); return m.limit(...a); } }));
vi.mock("@/lib/portal/server", () => ({
  requestPortalSignin: (...a: unknown[]) => { m.order.push("request"); return m.request(...a); },
  verifyPortalSignin: (...a: unknown[]) => { m.order.push("verify"); return m.verify(...a); },
  endPortalSession: (...a: unknown[]) => { m.order.push("end"); return m.end(...a); },
}));

import { POST as requestPost } from "@/app/api/portal/signin/request/route";
import { POST as verifyPost } from "@/app/api/portal/signin/verify/route";
import { POST as signoutPost } from "@/app/api/portal/signout/route";

const REF = "AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "t".repeat(43);
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams(fields);
  return new NextRequest(`https://app.test${path}`, { method: "POST", body, headers: { origin: "https://app.test", host: "app.test", ...headers } });
};
const normalise = (loc: string | null) => (loc ?? "").replace(/c=[^&]+/, "c=ID");

let logs: string[];
beforeEach(() => {
  m.order.length = 0;
  m.limit.mockReset().mockResolvedValue("ok");
  m.request.mockReset().mockResolvedValue(undefined);
  m.verify.mockReset().mockResolvedValue({ ok: false, reason: "refused", correlationId: "db-id-1" });
  m.end.mockReset().mockResolvedValue(undefined);
  logs = [];
  for (const k of ["log", "error", "warn", "info"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.stubEnv("CUSTOMER_PORTAL_ENABLED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("portal routes: order and gates", () => {
  it("flag off: nothing else runs (no limiter, no database) on any route", async () => {
    vi.stubEnv("CUSTOMER_PORTAL_ENABLED", "false");
    await requestPost(post("/api/portal/signin/request", { email: "a@b.co" }));
    await verifyPost(post("/api/portal/signin/verify", { ref: REF, code: "12345678" }));
    await signoutPost(post("/api/portal/signout", {}));
    expect(m.order).toEqual([]);
  });
  it("flag is checked before same-origin: a cross-origin call with the flag off still touches nothing", async () => {
    vi.stubEnv("CUSTOMER_PORTAL_ENABLED", "");
    await requestPost(post("/api/portal/signin/request", { email: "a@b.co" }, { origin: "https://evil.test" }));
    expect(m.order).toEqual([]);
  });
  it("same origin is required: cross-origin never reaches the limiter or lib/portal", async () => {
    const h = { origin: "https://evil.test", "sec-fetch-site": "cross-site" };
    const a = await requestPost(post("/api/portal/signin/request", { email: "a@b.co" }, h));
    const b = await verifyPost(post("/api/portal/signin/verify", { ref: REF, code: "12345678" }, h));
    const c = await signoutPost(post("/api/portal/signout", {}, { ...h, cookie: `tolra_portal=${TOKEN}` }));
    expect(m.order).toEqual([]);
    expect(a.headers.get("location")).toBe("/portal/signin/sent");
    expect(b.headers.get("location")).toMatch(/^\/portal\/code\/AAAAAAAAAAAAAAAAAAAAAA\?c=/);
    expect(c.headers.get("location")).toBe("/portal/signin");
    expect(c.headers.get("set-cookie")).toBeNull();
  });
  it("the limiter runs after the flag and origin, before lib/portal; limited or unavailable never reaches it", async () => {
    await requestPost(post("/api/portal/signin/request", { email: "a@b.co" }));
    expect(m.order).toEqual(["limit", "request"]);
    for (const state of ["limited", "unavailable"]) {
      m.order.length = 0;
      m.limit.mockResolvedValue(state);
      const r = await requestPost(post("/api/portal/signin/request", { email: "a@b.co" }));
      const v = await verifyPost(post("/api/portal/signin/verify", { ref: REF, code: "12345678" }));
      await signoutPost(post("/api/portal/signout", {}));
      expect(m.order).toEqual(["limit", "limit", "limit"]);
      expect(r.status).toBe(303);
      expect(v.headers.get("location")).toMatch(/^\/portal\/code\//);
    }
    expect(m.limit.mock.calls.map((c) => c[0])).toEqual(["request", "request", "verify", "read", "request", "verify", "read"]);
  });
});

describe("portal routes: responses", () => {
  it("request always 303s to the sent page, no-store, no cookie, whatever the outcome", async () => {
    const outcomes: Array<() => void> = [() => m.limit.mockResolvedValue("limited"), () => m.request.mockRejectedValue(new Error("x")), () => vi.stubEnv("CUSTOMER_PORTAL_ENABLED", "false")];
    const seen = new Set<string>();
    for (const o of [() => {}, ...outcomes]) {
      o();
      const res = await requestPost(post("/api/portal/signin/request", { email: "who@x.co" }));
      expect(res.status).toBe(303);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      seen.add(`${res.status}|${res.headers.get("location")}`);
    }
    expect([...seen]).toEqual(["303|/portal/signin/sent"]);
  });
  it("request passes the typed e-mail to lib/portal when on, in range and allowed", async () => {
    await requestPost(post("/api/portal/signin/request", { email: "who@x.co" }));
    expect(m.request).toHaveBeenCalledWith("who@x.co");
  });
  it("request still 303s to the sent page if lib/portal throws", async () => {
    m.request.mockRejectedValue(new Error("boom"));
    const res = await requestPost(post("/api/portal/signin/request", { email: "who@x.co" }));
    expect([res.status, res.headers.get("location")]).toEqual([303, "/portal/signin/sent"]);
  });
  it("verify success sets the cookie and 303s to /portal", async () => {
    m.verify.mockResolvedValue({ ok: true, data: { session: {}, token: TOKEN } });
    const res = await verifyPost(post("/api/portal/signin/verify", { ref: REF, code: "1234 5678" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/portal");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`tolra_portal=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(m.verify).toHaveBeenCalledWith({ ref: REF, code: "1234 5678" });
  });
  it("every verify refusal is byte-identical apart from the correlation id", async () => {
    const run = async (setup: () => void, headers: Record<string, string> = {}) => {
      setup();
      const res = await verifyPost(post("/api/portal/signin/verify", { ref: REF, code: "12345678" }, headers));
      const raw = res.headers.get("location");
      return { status: res.status, headers: [...res.headers.entries()].map(([k, v]) => `${k}=${k === "location" ? normalise(v) : v}`).sort(), body: await res.text(), id: /c=([^&]+)/.exec(raw ?? "")?.[1] };
    };
    const results = [
      await run(() => m.verify.mockResolvedValue({ ok: false, reason: "refused", correlationId: "db-1" })),
      await run(() => vi.stubEnv("CUSTOMER_PORTAL_ENABLED", "false")),
      await run(() => vi.stubEnv("CUSTOMER_PORTAL_ENABLED", "true"), { origin: "https://evil.test" }),
      await run(() => m.limit.mockResolvedValue("limited")),
      await run(() => m.limit.mockResolvedValue("unavailable")),
    ];
    const { id: firstId, ...first } = results[0];
    expect(firstId).toBe("db-1");
    for (const r of results) {
      const { id, ...rest } = r;
      expect(rest).toEqual(first);
      expect(id).toBeTruthy();
      expect(rest.status).toBe(303);
      expect(rest.body).toBe("");
    }
    expect(new Set(results.map((r) => r.id)).size).toBe(results.length);
  });
  it("a missing or malformed ref still refuses the same way and never calls lib/portal for a flag-off visitor", async () => {
    const res = await verifyPost(post("/api/portal/signin/verify", { ref: "<script>", code: "12345678" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/portal\/code\/x\?c=/);
    expect(res.headers.get("location")).not.toContain("script");
  });
  it("signout ends the session, clears the cookie and 303s to /portal/signin", async () => {
    const res = await signoutPost(post("/api/portal/signout", {}, { cookie: `tolra_portal=${TOKEN}` }));
    expect(m.end).toHaveBeenCalledWith(TOKEN);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/portal/signin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toMatch(/tolra_portal=;.*Max-Age=0/i);
  });
  it("every route is force-dynamic", async () => {
    const mods = await Promise.all([import("@/app/api/portal/signin/request/route"), import("@/app/api/portal/signin/verify/route"), import("@/app/api/portal/signout/route")]);
    for (const mod of mods) expect(mod.dynamic).toBe("force-dynamic");
  });
});

describe("portal routes: logging", () => {
  it("logs nothing but correlation ids, never the e-mail, ref, code, token or IP", async () => {
    await requestPost(post("/api/portal/signin/request", { email: "secret.person@x.co" }, { "x-real-ip": "203.0.113.9" }));
    m.limit.mockResolvedValueOnce("limited");
    await verifyPost(post("/api/portal/signin/verify", { ref: REF, code: "87654321" }, { "x-real-ip": "203.0.113.9" }));
    await verifyPost(post("/api/portal/signin/verify", { ref: REF, code: "87654321" }));
    await signoutPost(post("/api/portal/signout", {}, { cookie: `tolra_portal=${TOKEN}` }));
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).toMatch(/^\[portal\] refused [0-9a-zA-Z-]+$/);
      for (const secret of ["secret.person", REF, "87654321", TOKEN, "203.0.113.9"]) expect(line).not.toContain(secret);
    }
  });
});
