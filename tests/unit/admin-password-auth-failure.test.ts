/**
 * Admin "Set password" when Auth's answer is a refusal, unknown, or never comes (audit R1, failure injection).
 * The requirement is saved first; after an uncertain Auth result it is never put back to "off".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "org-a";

type AuthResult = { error: { status?: number; code?: string; message?: string } | null } | "throw" | "hang";

const state = {
  flag: false,
  flagWrites: [] as boolean[],
  authCalls: 0,
  authResults: [] as AuthResult[],
  audited: [] as string[],
};

const admin = {
  from(table: string) {
    if (table === "organization_members") {
      return { select: () => ({ eq: async () => ({ data: [{ organization_id: ORG }], error: null }) }) };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { must_change_password: state.flag }, error: null }) }) }),
      update: (row: { must_change_password: boolean }) => ({
        eq: () => ({
          select: async () => {
            state.flag = row.must_change_password;
            state.flagWrites.push(row.must_change_password);
            return { data: [{ must_change_password: state.flag }], error: null };
          },
        }),
      }),
    };
  },
  auth: {
    admin: {
      updateUserById: () => {
        state.authCalls += 1;
        const next = state.authResults.shift() ?? { error: null };
        if (next === "throw") return Promise.reject(new TypeError("fetch failed"));
        if (next === "hang") return new Promise(() => {});
        return Promise.resolve({ data: { user: null }, ...next });
      },
    },
  },
};

vi.mock("@/lib/server/admin-users", () => ({
  guard: async () => ({ auth: { user: { id: "admin-1" }, profile: { organization_id: ORG } }, admin }),
  audit: async (_ctx: unknown, action: string) => { state.audited.push(action); },
  loginIsProtected: async () => false,
}));

const { POST } = await import("@/app/api/admin/users/password/route");

const call = (mustChange: boolean) =>
  POST(new Request("http://localhost/api/admin/users/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: USER, password: "Correct-Horse-Battery-9", must_change_password: mustChange }),
  }));

beforeEach(() => {
  Object.assign(state, { flag: false, flagWrites: [], authCalls: 0, authResults: [], audited: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("admin set password: uncertain Auth results keep the requirement on (R1)", () => {
  for (const [name, result] of [
    ["a 500 from Auth", { error: { status: 500, code: "unexpected_failure" } }],
    ["a 502 gateway error", { error: { status: 502 } }],
    ["a 408 timeout from upstream", { error: { status: 408 } }],
    ["a retryable fetch error (status 0)", { error: { status: 0, code: "AuthRetryableFetchError" } }],
    ["an error with no status", { error: { message: "unknown" } }],
    ["a thrown network failure", "throw"],
  ] as [string, AuthResult][]) {
    it(`${name}: the flag stays on, 503 says the result is unknown, nothing audited`, async () => {
      state.authResults = [result];
      const response = await call(true);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.code).toBe("password_result_uncertain");
      expect(body.error).toContain("Press Set password again");
      expect(state.flag).toBe(true);
      expect(state.flagWrites).toEqual([true]); // set once, never restored to false
      expect(state.audited).toEqual([]);
    });
  }

  it("Auth never answers: after the timeout the flag stays on", async () => {
    vi.useFakeTimers();
    state.authResults = ["hang"];
    const pending = call(true);
    await vi.advanceTimersByTimeAsync(16_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(state.flag).toBe(true);
    expect(state.flagWrites).toEqual([true]);
  });

  it("clearing the requirement: an uncertain result puts it back on when it was on before", async () => {
    state.flag = true;
    state.authResults = [{ error: { status: 503 } }];
    const response = await call(false);
    expect(response.status).toBe(503);
    expect(state.flagWrites).toEqual([false, true]);
    expect(state.flag).toBe(true);
    expect((await response.json()).error).toContain("still have to choose a new password");
  });

  it("retry after an uncertain result: setting the password again succeeds and is audited once", async () => {
    state.authResults = ["throw", { error: null }];
    expect((await call(true)).status).toBe(503);
    const retry = await call(true);
    expect(retry.status).toBe(200);
    expect(state.authCalls).toBe(2);
    expect(state.flag).toBe(true);
    expect(state.audited).toEqual(["SET_USER_PASSWORD"]);
  });
});

describe("admin set password: a definite refusal restores the previous requirement", () => {
  it("422 weak password: the password didn't change, so the flag goes back to off", async () => {
    state.authResults = [{ error: { status: 422, code: "weak_password", message: "Password is too weak" } }];
    const response = await call(true);
    expect(response.status).toBe(400);
    expect(state.flagWrites).toEqual([true, false]);
    expect(state.flag).toBe(false);
  });

  it("success: flag on, audited", async () => {
    const response = await call(true);
    expect(response.status).toBe(200);
    expect(state.flag).toBe(true);
    expect(state.audited).toEqual(["SET_USER_PASSWORD"]);
  });
});
