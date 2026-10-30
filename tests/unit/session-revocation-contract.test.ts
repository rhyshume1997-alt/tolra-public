/**
 * S6: the seams between the database's revocation signals and the client's reaction to them, which no other unit test pins
 * (each side is tested alone: session-ended.test.ts, offline-sync-authority.test.ts, offline-support-session.test.ts,
 * access-recheck.test.ts). If either side is reworded or rewired, these fail instead of the sign-out silently stopping.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classifyAuthRefusal, sessionEndedError } from "@/lib/session-end";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");

describe("the database's own refusal text is what the client recognises", () => {
  const sql = read("supabase/migrations/017_session_and_deferred_link_checks.sql");
  const raise = /RAISE EXCEPTION '([^']+)' USING ERRCODE = '(\d{5})'/.exec(sql.slice(sql.indexOf("check_request_session()")));

  it("check_request_session raises 28000 'Your session has ended. Sign in again.'", () => {
    expect(raise?.[2]).toBe("28000");
    expect(raise?.[1]).toBe("Your session has ended. Sign in again.");
  });
  it("exactly that error, as PostgREST returns it, is a session that ended (queue kept), never a lost account", () => {
    const body = JSON.stringify({ code: raise?.[2], message: raise?.[1], details: null, hint: null });
    expect(classifyAuthRefusal(403, body)).toBe("session-ended");
    expect(sessionEndedError({ code: raise?.[2], message: raise?.[1] })).toBe(true);
  });
});

describe("the client keeps asking", () => {
  it("the sync loop runs every 60 seconds, on focus and when the connection returns, and each pass confirms the session (getUser, my_session)", () => {
    const sync = read("lib/offline/sync.ts");
    expect(sync).toMatch(/window\.setInterval\(run, 60_000\)/);
    expect(sync).toMatch(/document\.addEventListener\("visibilitychange", onVisible\)/);
    expect(sync).toMatch(/window\.addEventListener\("online", onOnline\)/);
    expect(sync).toMatch(/confirmedUser\(\{ maxAgeMs: CONFIRMED_USER_REUSE_MS \}\)/);
    expect(sync).toMatch(/supabase\.rpc\("my_session"\)/);
  });
  it("a sync pass that finds the session gone or a company/user/role mismatch reaches the access recheck (use-user) and the offline lock", () => {
    const useUser = read("lib/use-user.ts");
    expect(useUser).toMatch(/onSyncComplete\(\(event\) => \{\s*\n\s*if \(syncPassNeedsRecheck\(event, fullyConfirmedAt\)\) void recheck\?\.\(\);/);
    expect(read("lib/offline/sync.ts")).toMatch(/info\.user_id !== scope\.userId \|\| info\.organization_id !== scope\.orgId \|\| !info\.role\) \{\s*\n\s*suspendOfflineAccess\(scope\.userId\);/);
    expect(read("lib/supabase.ts")).toMatch(/kind === "access-ended"[\s\S]*suspendOfflineAccess\(refusedUser\)/);
  });
});
