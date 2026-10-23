/**
 * PR #118 run 39127930335 (access-recheck.spec.ts:61, "account disabled: two tabs lock"): after user_profiles.active=false and a
 * focus, tab 1 stayed on /jobs for the whole 30 s. Membership removal never failed this way, only a disabled account.
 *
 * Why only disabled: the middleware signs a disabled login out EVERYWHERE and clears the auth cookies (middleware.ts), and any
 * request from either tab can reach it (a Link prefetch). When that response lands while the focus recheck is between
 * auth.getUser (which still saw the session) and its two reads, supabase-js finds no session for the reads and sends them with
 * the anon key: the profile reads as "no row" and my_session is refused with 42501 (not 28000). The pass took that for "a
 * failed read is not an answer" and stopped. Nothing asked again within the test's wait: the sync pass skips (the middleware's
 * access-ended cookie blocks the scope, so no sync-complete recheck), the other tab is idle, the next check is 10 minutes away.
 *
 * The fake below is the browser's cookie jar, the server's sessions and the middleware's sign-out; the pass is the one
 * lib/use-user.ts runs (createRecheckRunner + askAccess + decideAccess).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type AccessReads, askAccess, createRecheckRunner, decideAccess } from "@/lib/access-recheck";
import { parseSessionInfo } from "@/lib/session-info";

const USER = "disabled-user";
const ORG = "beta-company";

function world() {
  const server = { sessions: new Set(["s1"]), active: true };
  const browser = { token: "s1" as string | null, accessEndedMark: false, network: true };
  /** A request from either tab reaches the middleware for a disabled account: signed out everywhere, cookies cleared, mark set. */
  const middlewareSignsOut = () => {
    server.sessions.delete("s1");
    browser.token = null;
    browser.accessEndedMark = true;
  };
  let afterGetUser: (() => void) | null = null;
  const offline = { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } };
  const reads: AccessReads = {
    getUser: async () => {
      if (!browser.network) return offline;
      const answer = !browser.token
        ? { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } }
        : !server.sessions.has(browser.token)
          ? { data: { user: null }, error: { name: "AuthApiError", status: 403 } }
          : { data: { user: { id: USER } }, error: null };
      const hook = afterGetUser;
      afterGetUser = null;
      hook?.();
      return answer;
    },
    // Each read takes the session from the cookies when it is sent; none there means the anon key (supabase-js _getAccessToken).
    readProfile: async () => {
      if (!browser.network) return { data: null, error: { message: "TypeError: Failed to fetch" } };
      if (!browser.token) return { data: null, error: null }; // anon: RLS shows no row
      if (!server.sessions.has(browser.token)) return { data: null, error: { code: "28000", message: "Your session has ended. Sign in again." } };
      return { data: { active: server.active }, error: null };
    },
    readSession: async () => {
      if (!browser.network) return { data: null, error: { message: "TypeError: Failed to fetch" } };
      if (!browser.token) return { data: null, error: { code: "42501", message: "permission denied for function my_session" } };
      if (!server.sessions.has(browser.token)) return { data: null, error: { code: "28000", message: "Your session has ended. Sign in again." } };
      return { data: server.active ? { user_id: USER, organization_id: ORG, role: "office" } : { user_id: USER, organization_id: null, role: null }, error: null };
    },
  };
  return { server, browser, reads, middlewareSignsOut, raceAfterGetUser: (fn: () => void) => { afterGetUser = fn; } };
}

/** The recheck lib/use-user.ts installs, reduced to what it decides: how access ended, or nothing. */
function page(w: ReturnType<typeof world>) {
  const ended: string[] = [];
  const live = { role: "office" as const, secondary_role: null, organization_id: ORG };
  const runner = createRecheckRunner(async () => {
    const read = await askAccess(w.reads, USER);
    if (read.kind === "session-gone") { ended.push(w.browser.accessEndedMark ? "disabled" : "signed-out"); return; } // sessionGoneReason
    if (read.kind === "signed-out") { ended.push("signed-out"); return; }
    if (read.kind === "no-answer") return;
    const now = parseSessionInfo(read.sessionResult.data);
    if (!now) return;
    const member = now.organization_id === live.organization_id && now.role ? { role: "office" as const, secondary_role: null, active: true } : null;
    const profile = read.profileResult.data ? { active: (read.profileResult.data as { active: boolean }).active, organization_id: now.organization_id ?? live.organization_id } : null;
    const decision = decideAccess(live, { signedIn: true, profile, membership: member });
    if (decision.kind === "end") ended.push(decision.reason);
  });
  const focus = async () => { await runner.ask(); };
  return { ended, focus };
}

describe("account disabled while the page is open: the focus recheck ends access", () => {
  it("when the middleware signs the account out between getUser and the reads (reads go out without the session)", async () => {
    const w = world();
    const tab = page(w);
    w.server.active = false;
    w.raceAfterGetUser(w.middlewareSignsOut); // another tab's prefetch lands just after this pass's getUser
    await tab.focus();
    // Before the fix: [] - the anon reads (no profile row, my_session 42501) were "a failed read", and the tab stayed open.
    expect(tab.ended).toEqual(["disabled"]);
  });

  it("when nothing races (the reads answer for the session): disabled", async () => {
    const w = world();
    const tab = page(w);
    w.server.active = false;
    await tab.focus();
    expect(tab.ended).toEqual(["disabled"]);
  });

  it("when the middleware signed out before the focus: disabled (the access-ended mark)", async () => {
    const w = world();
    const tab = page(w);
    w.server.active = false;
    w.middlewareSignsOut();
    await tab.focus();
    expect(tab.ended).toEqual(["disabled"]);
  });
});

describe("a failed read is still not an answer when the session is there", () => {
  it("the connection drops between getUser and the reads: nothing ends (the offline clock decides)", async () => {
    const w = world();
    const tab = page(w);
    w.raceAfterGetUser(() => { w.browser.network = false; });
    await tab.focus();
    expect(tab.ended).toEqual([]);
  });

  it("a server error on my_session with the session still valid: nothing ends", async () => {
    const w = world();
    const tab = page(w);
    w.reads.readSession = async () => ({ data: null, error: { code: "XX000", message: "internal error" } });
    await tab.focus();
    expect(tab.ended).toEqual([]);
  });

  it("an active account with no race keeps access", async () => {
    const w = world();
    const tab = page(w);
    await tab.focus();
    expect(tab.ended).toEqual([]);
  });
});

describe("lib/use-user.ts runs its recheck through askAccess", () => {
  const source = readFileSync(path.resolve(__dirname, "../../lib/use-user.ts"), "utf8");
  it("a session found gone (also after a refused read) ends access through sessionGoneReason", () => {
    expect(source).toMatch(/const read = await askAccess\(\{/);
    expect(source).toMatch(/if \(read\.kind === "session-gone"\) \{\s*\n\s*if \(mounted && !accessEnded\) await endAccess\(sessionGoneReason\(currentUser\.id\)\);/);
    expect(source).toMatch(/if \(read\.kind === "no-answer"\) return;/);
  });
});
