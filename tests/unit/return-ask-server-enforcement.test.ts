/**
 * Review condition (phone lag, fix 2d): createReturnAsk (lib/access-recheck.ts) skips the second client-side access recheck when
 * "visibilitychange" and "focus" arrive together (within RETURN_PAIR_MS, 30 s). That recheck only decides when THIS PAGE notices a
 * revocation. It never gates the server: every API request is checked on its own by requireProfile (lib/server/auth.ts: getUser,
 * user_profiles.active, current_user_organization_id, my_session), and every database request by the request hook
 * (supabase/migrations/017 check_request_session -> session_is_active, 28000) and RLS on the membership (tests/db/session-revocation.test.ts).
 * Here: a revoked person's API call is refused at once, and the same, whether or not a return recheck was just suppressed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

type Revocation = null | "session-ended" | "removed" | "disabled" | "database-28000";
const server = vi.hoisted(() => ({ revoked: null as Revocation, calls: [] as string[] }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      server.calls.push("user_profiles");
      return { data: { id: "u-1", email: "office@example.test", full_name: "Office", role: "office", secondary_role: null, organization_id: "org-1", active: server.revoked !== "disabled", must_change_password: false }, error: null };
    };
    return {
      auth: {
        getUser: async () => {
          server.calls.push("getUser");
          return server.revoked === "session-ended" ? { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } } : { data: { user: { id: "u-1" } }, error: null };
        },
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
      },
      from: () => chain,
      rpc: async (name: string) => {
        server.calls.push(name);
        if (server.revoked === "database-28000") return { data: null, error: { code: "28000", message: "Your session has ended. Sign in again." } };
        if (name === "current_user_organization_id") return { data: "org-1", error: null };
        if (name === "my_session") return { data: { user_id: "u-1", organization_id: "org-1", role: server.revoked === "removed" ? null : "office", secondary_role: null, hidden_sections: [] }, error: null };
        return { data: null, error: null };
      },
    };
  },
}));

import { RETURN_PAIR_MS, createReturnAsk } from "@/lib/access-recheck";
import { isErrorResponse, requireProfile } from "@/lib/server/auth";
import { POST as reportError } from "@/app/api/report-error/route";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
beforeEach(() => {
  for (const key of ENV) delete process.env[key];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  server.revoked = null;
  server.calls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** What a protected call answers: the guard's status, or 200 when it lets the caller in. */
async function guarded(): Promise<number> {
  const auth = await requireProfile();
  return isErrorResponse(auth) ? (auth as NextResponse).status : 200;
}

describe("a suppressed return recheck does not change what a protected call answers", () => {
  const REVOKED: [Exclude<Revocation, null>, number][] = [["session-ended", 401], ["removed", 403], ["disabled", 403], ["database-28000", 403]];

  it.each(REVOKED)("revoked (%s): refused with %i on the very next call, inside the 30 s window and outside it alike", async (kind, status) => {
    const ask = createReturnAsk();
    const t = 1_000_000;
    // Signed in: let in.
    expect(await guarded()).toBe(200);
    // The person comes back to the app: the visible event asks for the recheck...
    expect(ask("visible", t)).toBe(true);
    server.revoked = kind;
    // ...the focus event 50 ms later is suppressed (the pair already asked): the client does no second recheck.
    expect(ask("focus", t + 50)).toBe(false);
    // The server does not wait for any recheck: the next protected call asks the auth server and the database itself.
    server.calls.length = 0;
    expect(await guarded()).toBe(status);
    expect(server.calls[0]).toBe("getUser");
    // Outside the window (nothing suppressed) the answer is the same: suppression changed nothing on the server.
    expect(ask("focus", t + RETURN_PAIR_MS + 1)).toBe(true);
    expect(await guarded()).toBe(status);
  });

  it("a real route (POST /api/report-error, requireProfile first) refuses the revoked caller while a return recheck is suppressed", async () => {
    const ask = createReturnAsk();
    expect(ask("visible", 0)).toBe(true);
    server.revoked = "removed";
    expect(ask("focus", 10)).toBe(false);
    const response = await reportError(new Request("https://app.test/api/report-error", { method: "POST", body: JSON.stringify({ message: "x" }) }));
    expect(response.status).toBe(403);
  });

  it("every protected call asks again (nothing is cached between calls, so no client timing can delay a refusal)", async () => {
    await guarded();
    await guarded();
    expect(server.calls.filter((name) => name === "getUser")).toHaveLength(2);
    expect(server.calls.filter((name) => name === "my_session")).toHaveLength(2);
  });

  it("the server guard shares no state with the client recheck: lib/server/auth.ts does not import lib/access-recheck", () => {
    const source = readFileSync(join(__dirname, "..", "..", "lib", "server", "auth.ts"), "utf8");
    expect(source).not.toMatch(/from "@\/lib\/access-recheck"/);
    expect(source).not.toMatch(/createReturnAsk|RETURN_PAIR_MS/);
  });
});
