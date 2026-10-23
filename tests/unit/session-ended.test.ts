/** Revocation blocks cached access while preserving work for authorised recovery. Session expiry also preserves work. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { decideAccess } from "@/lib/access-recheck";
import { enqueue, pendingEntries, type OutboxOp } from "@/lib/offline/outbox";
import { setOfflineScope, suspendOfflineAccess, offlineScope } from "@/lib/offline/scope";
import { loadSnapshot, memoryBackend, saveSnapshot, setOfflineBackend } from "@/lib/offline/store";
import { classifyAuthRefusal, requestSubject } from "@/lib/session-end";
import { LOCK_NOTICE_KEY } from "@/lib/session-policy";
import { sessionEndedFetch } from "@/lib/supabase";

const alice = { userId: "user-a", orgId: "org-1" };
const bob = { userId: "user-b", orgId: "org-1" };
const start = (jobNo: string): OutboxOp => ({ kind: "start", jobId: `id-${jobNo}`, jobNo, at: "2026-10-09T08:00:00Z" });

const ended = JSON.stringify({ code: "28000", message: "Your session has ended. Sign in again." });

let storage: Map<string, string>;
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  confirmOfflineAccess(alice.userId);
  setOfflineBackend(memoryBackend());
  storage = new Map();
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
  };
});
afterEach(() => {
  setOfflineBackend(null);
  setOfflineScope(null);
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
  confirmOfflineAccess(alice.userId);
});

function answerWith(body: string, status = 403) {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}

describe("classifyAuthRefusal", () => {
  it("28000 'Your session has ended' (017's request check) is a session that ended, not a lost account", () => {
    expect(classifyAuthRefusal(403, ended)).toBe("session-ended");
    expect(classifyAuthRefusal(401, "Your session has ended. Sign in again.")).toBe("session-ended");
  });
  it("28000 that cannot be told apart from a session ending counts as a session ending (the queue is kept)", () => {
    expect(classifyAuthRefusal(403, JSON.stringify({ code: "28000" }))).toBe("session-ended");
    expect(classifyAuthRefusal(403, JSON.stringify({ code: "28000", message: "something new" }))).toBe("session-ended");
  });
  it("a refusal that says the account is disabled or removed is access ended", () => {
    expect(classifyAuthRefusal(403, JSON.stringify({ code: "28000", message: "Your account has been disabled." }))).toBe("access-ended");
    expect(classifyAuthRefusal(403, JSON.stringify({ code: "28000", message: "You have been removed from this company." }))).toBe("access-ended");
  });
  it("other refusals and successes are not about the session", () => {
    expect(classifyAuthRefusal(403, JSON.stringify({ code: "42501", message: "permission denied for table jobs" }))).toBe("none");
    expect(classifyAuthRefusal(200, ended)).toBe("none");
    expect(classifyAuthRefusal(500, ended)).toBe("none");
  });
});

describe("the server ends the session (017, 28000)", () => {
  it("keeps the queue and the copies, and records the pending count for the sign-in page", async () => {
    setOfflineScope(alice);
    await enqueue(alice, start("J-1"));
    await enqueue(alice, start("J-2"));
    await saveSnapshot(alice, "jobs", [1]);
    answerWith(ended);

    const response = await sessionEndedFetch("https://example.test/rest/v1/jobs");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "28000" }); // still readable by the caller

    expect((await pendingEntries(alice)).map((e) => e.op)).toHaveLength(2);
    expect((await loadSnapshot(alice, "jobs"))?.data).toEqual([1]);
    expect(JSON.parse(storage.get(LOCK_NOTICE_KEY)!)).toMatchObject({ reason: "ended", pending: 2 });
  });

  it("the kept queue stays bound to the same person: someone else on the device does not see it", async () => {
    setOfflineScope(alice);
    await enqueue(alice, start("J-1"));
    answerWith(ended);
    await sessionEndedFetch("https://example.test/rest/v1/jobs");
    expect(await pendingEntries(bob)).toEqual([]);
    expect(await pendingEntries({ userId: "user-a", orgId: "org-2" })).toEqual([]);
    expect(await pendingEntries(alice)).toHaveLength(1);
  });
});

describe("disabled or removed", () => {
  it("a refusal that says the account is disabled locks access and preserves the queue", async () => {
    setOfflineScope(alice);
    await enqueue(alice, start("J-1"));
    answerWith(JSON.stringify({ code: "28000", message: "Your account has been disabled." }));
    await sessionEndedFetch("https://example.test/rest/v1/jobs");
    expect(await pendingEntries(alice)).toHaveLength(1);
    expect(offlineScope()).toBeNull();
  });

  it("the access recheck ends access for disabled and removed people, and that path preserves the queue", async () => {
    const current = { role: "office", secondary_role: null, organization_id: "org-1" } as const;
    expect(decideAccess(current, { signedIn: true, profile: { active: false, organization_id: "org-1" }, membership: null })).toEqual({ kind: "end", reason: "disabled" });
    expect(decideAccess(current, { signedIn: true, profile: { active: true, organization_id: "org-1" }, membership: null })).toEqual({ kind: "end", reason: "removed" });
    setOfflineScope(alice);
    await enqueue(alice, start("J-1"));
    await saveSnapshot(alice, "jobs", [1]);
    suspendOfflineAccess(alice.userId); // disabled / removed / moved
    expect(await pendingEntries(alice)).toHaveLength(1);
    expect(offlineScope()).toBeNull();
  });
});

describe("access ended with no offline scope in use (B23 follow-up)", () => {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;
  const disabled = JSON.stringify({ code: "28000", message: "Your account has been disabled." });

  it("reads the refused request's user from its bearer token, and nothing from the anon key or no header", () => {
    expect(requestSubject("https://x.test", { headers: new Headers({ Authorization: `Bearer ${jwt({ sub: "user-a", role: "authenticated" })}` }) })).toBe("user-a");
    expect(requestSubject("https://x.test", { headers: { authorization: `Bearer ${jwt({ sub: "user-a" })}` } })).toBe("user-a");
    expect(requestSubject("https://x.test", { headers: { Authorization: `Bearer ${jwt({ role: "anon" })}` } })).toBeNull();
    expect(requestSubject("https://x.test", { headers: { Authorization: "Bearer sb_publishable_abc" } })).toBeNull();
    expect(requestSubject("https://x.test")).toBeNull();
  });

  it("fails closed: the person the request was sent as is locked out of cached access, and their queue is kept", async () => {
    await enqueue(alice, start("J-1"));
    expect(offlineScope()).toBeNull(); // the profile is still loading: no scope yet
    answerWith(disabled);
    const response = await sessionEndedFetch("https://example.test/rest/v1/user_profiles", { headers: { Authorization: `Bearer ${jwt({ sub: alice.userId, role: "authenticated" })}` } });
    expect(response.status).toBe(403);
    expect(offlineAccessBlocked(alice.userId)).toBe(true);
    expect(offlineAccessBlocked(bob.userId)).toBe(false);
    // An offline start-up from the cached identity can no longer reopen the work.
    setOfflineScope(alice);
    expect(offlineScope()).toBeNull();
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  it("an anonymous request refused that way blocks no one", async () => {
    answerWith(disabled);
    await sessionEndedFetch("https://example.test/rest/v1/jobs", { headers: { Authorization: `Bearer ${jwt({ role: "anon" })}` } });
    expect(offlineAccessBlocked(alice.userId)).toBe(false);
  });
});

describe("a queued change meets an ended session during sync", () => {
  it("is treated as offline (it waits), not held as rejected", async () => {
    const { isNetworkError } = await import("@/lib/offline/store");
    expect(isNetworkError({ code: "28000", message: "Your session has ended. Sign in again." })).toBe(true);
    expect(isNetworkError({ message: "Your session has ended. Sign in again." })).toBe(true);
    expect(isNetworkError({ code: "42501", message: "permission denied for table jobs" })).toBe(false);
  });
});
