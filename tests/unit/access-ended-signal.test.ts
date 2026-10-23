/**
 * B23 follow-up (PR #97 run 39106343267, access-recheck "account disabled: two tabs lock"). The middleware refuses a disabled
 * account by signing the login out everywhere and clearing the shared auth cookies, often on a prefetch no tab ever sees. An open
 * tab's recheck then found "no session" and took it for a timeout: no access-ended mark, the offline scope stayed usable, and the
 * other tabs were never told. These tests reproduce that path and check it now locks (keeping the work), while a plain timeout
 * still only signs out, and that a tab finding its session gone asks the other tabs to check at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  user: { id: "disabled-alice" } as { id: string } | null,
  profile: { role: "office", secondary_role: null, active: false, organization_id: "org-a", must_change_password: false } as Record<string, unknown> | null,
  signOut: vi.fn(async () => ({ error: null })),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: server.user }, error: null }), signOut: server.signOut, mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" } }) } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: server.profile, error: null }) }) }) }),
    rpc: async () => ({ data: { user_id: server.user?.id, organization_id: "org-a", role: "office", secondary_role: null, hidden_sections: [] }, error: null }),
  }),
}));

import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { ACCESS_RECHECK_KEY, OFFLINE_ACCESS_PREFIX, accessEndedCookie, accessSignal, adoptServerAccessEnded, confirmOfflineAccess, offlineAccessBlocked, sessionGoneReason, signalAccessRecheck } from "@/lib/offline/access";
import { enqueue, pendingEntries } from "@/lib/offline/outbox";
import { loadOfflineIdentity, offlineScope, saveOfflineIdentity, setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";
import { authSessionGone, sessionEndedError } from "@/lib/session-end";

const alice = { userId: "disabled-alice", orgId: "org-a" };

/** One browser: a cookie jar and a localStorage shared by every tab; a write in this tab reaches the other tabs as a storage event. */
function browser() {
  const jar = new Map<string, string>();
  const local = new Map<string, string>();
  const otherTabs: Array<(event: { key: string; newValue: string | null }) => void> = [];
  const storageEvent = (key: string, newValue: string | null, oldValue: string | null) => {
    if (newValue !== oldValue) for (const tab of otherTabs) tab({ key, newValue });
  };
  vi.stubGlobal("document", {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
    set cookie(text: string) {
      const [pair, ...attrs] = text.split(";");
      const [name, value] = pair.split("=");
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name.trim());
      else jar.set(name.trim(), value);
    },
  });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => { const old = local.get(k) ?? null; local.set(k, v); storageEvent(k, v, old); },
      removeItem: (k: string) => { const old = local.get(k) ?? null; local.delete(k); storageEvent(k, null, old); },
    },
    dispatchEvent: () => true,
  });
  return { jar, local, otherTabs };
}

/** What the browser keeps from a middleware response's Set-Cookie headers (the attributes are checked separately). */
function applySetCookies(jar: Map<string, string>, response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attrs] = header.split(";");
    const [name, value] = pair.split("=");
    if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a))) jar.delete(name.trim());
    else jar.set(name.trim(), value);
  }
}

let records: Map<string, unknown>;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  server.user = { id: alice.userId };
  server.profile = { role: "office", secondary_role: null, active: false, organization_id: "org-a", must_change_password: false };
  server.signOut.mockClear();
  records = new Map(); setOfflineBackend(memoryBackend(records)); setSupportSession(false);
});
afterEach(() => {
  confirmOfflineAccess(alice.userId);
  setOfflineScope(null); setOfflineBackend(null);
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe("a disabled account refused by the middleware (B23: keep and lock)", () => {
  it("a prefetch the tab never sees still marks access ended: the recheck locks, offline access is suspended, the work stays", async () => {
    const { jar, local, otherTabs } = browser();
    await saveOfflineIdentity(alice.userId, { profile: { organization_id: alice.orgId }, organizations: [], hiddenSections: [] });
    await enqueue(alice, { kind: "start", jobId: "job-1", jobNo: "J-1", at: "2026-10-18T08:00:00Z" });
    setOfflineScope(alice);
    jar.set("sb-127-auth-token", "session");
    const before = structuredClone(records);

    const response = await middleware(new NextRequest("http://localhost:3001/jobs/abc?_rsc=1", { headers: { "next-router-prefetch": "1", cookie: "sb-127-auth-token=session" } }));
    expect(server.signOut).toHaveBeenCalledOnce();
    expect(response.headers.get("location")).toMatch(/\/login\?disabled=1$/);
    const mark = response.cookies.get(accessEndedCookie(alice.userId).name);
    expect(mark?.value).toBe("1");
    expect(mark).toMatchObject({ path: "/", sameSite: "strict" });
    expect(mark?.httpOnly).not.toBe(true); // the open tab must be able to read it

    // The browser drops the auth cookie (the sign-out) and keeps the mark; the tab's recheck now finds no session.
    jar.delete("sb-127-auth-token");
    applySetCookies(jar, response);
    expect(sessionGoneReason(alice.userId)).toBe("disabled"); // was "signed-out": a timeout, with offline access left open
    expect(offlineAccessBlocked(alice.userId)).toBe(true);
    expect(offlineScope()).toBeNull();
    // Opening the offline copy while offline is refused: the identity can't be read back, so no cached start-up.
    expect(await loadOfflineIdentity(alice.userId)).toBeNull();
    // Nothing deleted.
    expect(records).toEqual(before);
    expect(await pendingEntries(alice)).toHaveLength(1);

    // The tab sent to /login?disabled=1 copies the mark into storage: every other open tab hears it and locks.
    const heard: Array<"end" | "recheck" | null> = [];
    otherTabs.push((event) => heard.push(accessSignal(event, alice.userId)));
    expect(adoptServerAccessEnded()).toEqual([alice.userId]);
    expect(local.get(OFFLINE_ACCESS_PREFIX + alice.userId)).toBe("1");
    expect(heard).toEqual(["end"]);
    expect(adoptServerAccessEnded()).toEqual([]); // already marked: no repeat
  });

  it("an active account gets no mark from the middleware, and a plain timeout stays a sign-out that keeps offline access", async () => {
    const { jar } = browser();
    server.profile = { ...server.profile, active: true };
    const response = await middleware(new NextRequest("http://localhost:3001/jobs", { headers: { cookie: "sb-127-auth-token=session" } }));
    expect(server.signOut).not.toHaveBeenCalled();
    expect(response.cookies.get(accessEndedCookie(alice.userId).name)).toBeUndefined();
    applySetCookies(jar, response);
    setOfflineScope(alice);
    expect(sessionGoneReason(alice.userId)).toBe("signed-out");
    expect(offlineScope()).toEqual(alice);
    expect(sessionGoneReason(null)).toBe("signed-out");
  });

  it("a fresh server confirmation clears the mark again", () => {
    const { jar } = browser();
    const cookie = accessEndedCookie(alice.userId);
    jar.set(cookie.name, cookie.value);
    expect(offlineAccessBlocked(alice.userId)).toBe(true);
    confirmOfflineAccess(alice.userId);
    expect(offlineAccessBlocked(alice.userId)).toBe(false);
  });
});

describe("a tab that finds its session gone tells the others to check now", () => {
  it("every signal reaches the other tabs as a recheck, also the second time", () => {
    const { otherTabs } = browser();
    const heard: Array<"end" | "recheck" | null> = [];
    otherTabs.push((event) => heard.push(accessSignal(event, alice.userId)));
    signalAccessRecheck();
    signalAccessRecheck();
    expect(heard).toEqual(["recheck", "recheck"]);
  });

  it("reads storage events: this person's mark locks, a recheck asks the server, anything else is ignored", () => {
    expect(accessSignal({ key: OFFLINE_ACCESS_PREFIX + alice.userId, newValue: "1" }, alice.userId)).toBe("end");
    expect(accessSignal({ key: OFFLINE_ACCESS_PREFIX + "someone-else", newValue: "1" }, alice.userId)).toBeNull();
    expect(accessSignal({ key: OFFLINE_ACCESS_PREFIX + alice.userId, newValue: null }, alice.userId)).toBeNull();
    expect(accessSignal({ key: ACCESS_RECHECK_KEY, newValue: "123-abc" }, alice.userId)).toBe("recheck");
    expect(accessSignal({ key: ACCESS_RECHECK_KEY, newValue: "123-abc" }, null)).toBeNull();
    expect(accessSignal({ key: "active-role", newValue: "office" }, alice.userId)).toBeNull();
  });
});

describe("which answers mean the session is gone", () => {
  it("auth.getUser: missing, 401 and 403 are; a network failure is not", () => {
    expect(authSessionGone({ name: "AuthSessionMissingError", status: 400 })).toBe(true);
    expect(authSessionGone({ name: "AuthApiError", status: 403 })).toBe(true);
    expect(authSessionGone({ name: "AuthApiError", status: 401 })).toBe(true);
    expect(authSessionGone({ name: "AuthRetryableFetchError", status: 0 })).toBe(false);
    expect(authSessionGone(null)).toBe(false);
  });

  it("a REST refusal with 28000 or 'Your session has ended' is; other errors are not", () => {
    expect(sessionEndedError({ code: "28000", message: "Your session has ended. Sign in again." })).toBe(true);
    expect(sessionEndedError({ message: "Your session has ended. Sign in again." })).toBe(true);
    expect(sessionEndedError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(sessionEndedError({ message: "TypeError: Failed to fetch" })).toBe(false);
    expect(sessionEndedError(null)).toBe(false);
  });
});
