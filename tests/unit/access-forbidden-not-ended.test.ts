/**
 * PR #103 review: a 403 that is NOT a dead session (row-level security, "permission denied", a refused upload) must not end access
 * or lock the offline copy. Only the session-gone signals do: auth.getUser saying the session is missing/401/403, or the request
 * check's 28000 "Your session has ended". The person still has a valid session here; a refusal of one request is the answer to
 * that request, nothing more.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACCESS_RECHECK_KEY, OFFLINE_ACCESS_PREFIX, confirmOfflineAccess, offlineAccessBlocked, sessionGoneReason } from "@/lib/offline/access";
import { enqueue, pendingEntries, type OutboxOp } from "@/lib/offline/outbox";
import { offlineScope, setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { authSessionGone, classifyAuthRefusal, sessionEndedError } from "@/lib/session-end";
import { LOCK_NOTICE_KEY } from "@/lib/session-policy";
import { sessionEndedFetch } from "@/lib/supabase";

const alice = { userId: "forbidden-alice", orgId: "org-1" };
const start: OutboxOp = { kind: "start", jobId: "job-1", jobNo: "J-1", at: "2026-10-18T08:00:00Z" };

/** PostgREST / Storage refusals with HTTP 403 that say nothing about the session (supabase-js hands back {code, message, ...}). */
const forbidden = [
  { code: "42501", message: "permission denied for table jobs", details: null, hint: null },
  { code: "42501", message: 'new row violates row-level security policy for table "job_photos"', details: null, hint: null },
  { code: "P0001", message: "This job was removed and can't be changed.", details: null, hint: null },
  { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" },
];

let storage: Map<string, string>;
let cookies: string[];
let events: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  confirmOfflineAccess(alice.userId);
  setOfflineBackend(memoryBackend());
  storage = new Map(); cookies = []; events = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
  };
  (globalThis as { document?: unknown }).document = {
    get cookie() { return cookies.join("; "); },
    set cookie(text: string) { cookies.push(text.split(";")[0]); },
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setOfflineScope(null); setOfflineBackend(null);
  confirmOfflineAccess(alice.userId);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe("a 403 that is not a dead session", () => {
  it.each(forbidden)("is not classified as session gone or access ended: %j", (error) => {
    expect(classifyAuthRefusal(403, JSON.stringify(error))).toBe("none");
    expect(sessionEndedError(error)).toBe(false);
    // authSessionGone reads auth.getUser's error only; a REST refusal object is never "the session is gone".
    expect(authSessionGone(error as { name?: string; status?: number })).toBe(false);
  });

  it.each(forbidden)("through the app's fetch: no suspension, no marks, no notice, no signal, the queue is kept (%j)", async (error) => {
    await enqueue(alice, start);
    setOfflineScope(alice);
    globalThis.fetch = (async () => new Response(JSON.stringify(error), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;

    const response = await sessionEndedFetch("http://127.0.0.1:54321/rest/v1/jobs?select=*", { headers: { Authorization: "Bearer x.eyJzdWIiOiJmb3JiaWRkZW4tYWxpY2UifQ.y" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(error); // the caller still gets the refusal to handle

    expect(offlineAccessBlocked(alice.userId)).toBe(false);
    expect(offlineScope()).toEqual(alice);
    expect(storage.get(OFFLINE_ACCESS_PREFIX + alice.userId)).toBeUndefined();
    expect(cookies.some((c) => c.startsWith("tolra_offline_blocked_"))).toBe(false);
    expect(storage.has(LOCK_NOTICE_KEY)).toBe(false);
    expect(storage.has(ACCESS_RECHECK_KEY)).toBe(false);
    expect(events).toEqual([]);
    expect(sessionGoneReason(alice.userId)).toBe("signed-out"); // even if a recheck ever asked, nothing marks this person
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  it("for contrast, the request check's 28000 is the session-ended signal (and still keeps the queue)", async () => {
    const ended = { code: "28000", message: "Your session has ended. Sign in again." };
    expect(classifyAuthRefusal(403, JSON.stringify(ended))).toBe("session-ended");
    expect(sessionEndedError(ended)).toBe(true);
    expect(authSessionGone({ name: "AuthApiError", status: 403 })).toBe(true); // auth.getUser's own 403: session_not_found
  });
});
