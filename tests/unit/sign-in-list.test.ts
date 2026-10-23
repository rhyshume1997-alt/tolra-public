/**
 * The list behind Admin > Users' sign-in badges (lib/server/sign-in-list): the same answer as the old member-by-member loop, from one
 * membership read and Auth lookups run a few at a time.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type BanState, banState, ownsIdentity } from "@/lib/server/admin-users";
import { BAN_LOOKUP_CONCURRENCY, loginsOwnedBy, mapWithLimit, protectedStates, signInStates, stateOf } from "@/lib/server/sign-in-list";

const ORG = "org-here";
const OTHER_ORG = "org-elsewhere";
const SELF = "u-self";

type Membership = { user_id: string; organization_id: string };
type AuthUser = { banned_until: string | null; app_metadata: Record<string, unknown> } | "error";
const FOREVER = "2125-01-01T00:00:00Z";

function fakeAdmin(memberships: Membership[], users: Record<string, AuthUser>, options: { readError?: boolean } = {}) {
  const stats = { membershipReads: 0, authCalls: 0, inFlight: 0, maxInFlight: 0 };
  const admin = {
    from: (table: string) => {
      if (table !== "organization_members") throw new Error(`unexpected table ${table}`);
      stats.membershipReads += 1;
      let eq: [string, unknown] | null = null;
      let list: [string, unknown[]] | null = null;
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => { eq = [column, value]; return chain; },
        in: (column: string, values: unknown[]) => { list = [column, values]; return chain; },
        then: (resolve: (value: { data: Membership[] | null; error: { message: string } | null }) => unknown) => {
          if (options.readError) return resolve({ data: null, error: { message: "boom" } });
          const rows = memberships.filter((m) => (!eq || (m as Record<string, unknown>)[eq[0]] === eq[1]) && (!list || list[1].includes((m as Record<string, unknown>)[list[0]])));
          return resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          stats.authCalls += 1;
          stats.inFlight += 1;
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
          await new Promise((done) => setTimeout(done, 5));
          stats.inFlight -= 1;
          const user = users[id];
          if (user === "error" || !user) return { data: { user: null }, error: { status: 500 } };
          return { data: { user: { id, ...user } }, error: null };
        },
      },
    },
  };
  return { admin: admin as never, stats };
}

/** The loop as it was before: one membership read and one Auth lookup per member, one after the other. */
async function sequential(admin: never, members: Array<{ user_id: string; active: boolean; support: boolean }>) {
  const out: Array<{ user_id: string; sign_in: string }> = [];
  for (const member of members) {
    if (!member.active || member.support || member.user_id === SELF) continue;
    if (!(await ownsIdentity(admin, member.user_id, ORG))) continue;
    out.push({ user_id: member.user_id, sign_in: stateOf(await banState(admin, member.user_id), ORG) });
  }
  return out;
}

const member = (user_id: string, extra: Partial<{ active: boolean; support: boolean }> = {}) => ({ user_id, active: true, support: false, ...extra });
const ok = (extra: Partial<Exclude<AuthUser, "error">> = {}): AuthUser => ({ banned_until: null, app_metadata: {}, ...extra });

describe("stateOf", () => {
  it("unknown without a ban reading, on when not banned, off for this company's marker (or a legacy one), else off_platform", () => {
    expect(stateOf(null, ORG)).toBe("unknown");
    expect(stateOf({ banned: false, appBan: false, banOrg: null }, ORG)).toBe("on");
    expect(stateOf({ banned: true, appBan: true, banOrg: ORG }, ORG)).toBe("off");
    expect(stateOf({ banned: true, appBan: true, banOrg: null }, ORG)).toBe("off");
    expect(stateOf({ banned: true, appBan: true, banOrg: OTHER_ORG }, ORG)).toBe("off_platform");
    expect(stateOf({ banned: true, appBan: false, banOrg: null } satisfies BanState, ORG)).toBe("off_platform");
  });
});

describe("signInStates gives the old loop's answer", () => {
  const memberships: Membership[] = [
    { user_id: SELF, organization_id: ORG },
    { user_id: "a", organization_id: ORG },
    { user_id: "shared", organization_id: ORG }, { user_id: "shared", organization_id: OTHER_ORG },
    { user_id: "support", organization_id: ORG },
    { user_id: "banned-here", organization_id: ORG },
    { user_id: "banned-platform", organization_id: ORG },
    { user_id: "unreadable", organization_id: ORG },
    { user_id: "inactive", organization_id: ORG },
    { user_id: "elsewhere-only", organization_id: OTHER_ORG },
    { user_id: "z", organization_id: ORG },
  ];
  const users: Record<string, AuthUser> = {
    a: ok(), shared: ok(), support: ok(), z: ok(), inactive: ok(), "elsewhere-only": ok(),
    "banned-here": ok({ banned_until: FOREVER, app_metadata: { deactivation_ban: true, deactivation_ban_org: ORG } }),
    "banned-platform": ok({ banned_until: FOREVER }),
    unreadable: "error",
  };
  const members = [
    member(SELF), member("a"), member("shared"), member("support", { support: true }), member("banned-here"), member("banned-platform"),
    member("unreadable"), member("inactive", { active: false }), member("ghost"), member("z"),
  ];

  it("same users, same order, same states, unreadable shown as unknown", async () => {
    const before = await sequential(fakeAdmin(memberships, users).admin, members);
    const after = await signInStates(fakeAdmin(memberships, users).admin, members, SELF, ORG);
    expect(after).toEqual(before);
    expect(after).toEqual([
      { user_id: "a", sign_in: "on" },
      { user_id: "banned-here", sign_in: "off" },
      { user_id: "banned-platform", sign_in: "off_platform" },
      { user_id: "unreadable", sign_in: "unknown" },
      { user_id: "z", sign_in: "on" },
    ]);
  });

  it("a failed membership read lists nobody, as every per-member read failing did", async () => {
    const failing = fakeAdmin(memberships, users, { readError: true }).admin;
    expect(await sequential(failing, members)).toEqual([]);
    expect(await signInStates(failing, members, SELF, ORG)).toEqual([]);
  });

  it("reads the memberships once, however many members, and no Auth lookup for anyone not listed", async () => {
    const { admin, stats } = fakeAdmin(memberships, users);
    await signInStates(admin, members, SELF, ORG);
    expect(stats.membershipReads).toBe(1);
    expect(stats.authCalls).toBe(5);
  });

  it("with nobody to look at, nothing is read", async () => {
    const { admin, stats } = fakeAdmin(memberships, users);
    expect(await signInStates(admin, [member(SELF), member("support", { support: true })], SELF, ORG)).toEqual([]);
    expect(stats.membershipReads).toBe(0);
  });
});

describe("the Auth lookups run side by side, at most BAN_LOOKUP_CONCURRENCY at a time", () => {
  it("many members: parallel but capped, order kept", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, "0")}`);
    const { admin, stats } = fakeAdmin(ids.map((user_id) => ({ user_id, organization_id: ORG })), Object.fromEntries(ids.map((id) => [id, ok()])));
    const result = await signInStates(admin, ids.map((id) => member(id)), SELF, ORG);
    expect(result.map((row) => row.user_id)).toEqual(ids);
    expect(BAN_LOOKUP_CONCURRENCY).toBe(8);
    expect(stats.maxInFlight).toBeGreaterThan(1);
    expect(stats.maxInFlight).toBeLessThanOrEqual(BAN_LOOKUP_CONCURRENCY);
  });
});

describe("loginsOwnedBy and mapWithLimit", () => {
  it("owned = every membership here; none, or a failed read, = not owned", async () => {
    const { admin } = fakeAdmin([{ user_id: "a", organization_id: ORG }, { user_id: "b", organization_id: ORG }, { user_id: "b", organization_id: OTHER_ORG }], {});
    expect([...(await loginsOwnedBy(admin, ["a", "b", "c"], ORG))]).toEqual(["a"]);
    // Whichever order the rows come back in, a login with a membership elsewhere is not owned.
    const reversed = fakeAdmin([{ user_id: "b", organization_id: OTHER_ORG }, { user_id: "b", organization_id: ORG }, { user_id: "a", organization_id: ORG }], {}).admin;
    expect([...(await loginsOwnedBy(reversed, ["a", "b"], ORG))]).toEqual(["a"]);
    expect((await loginsOwnedBy(fakeAdmin([], {}, { readError: true }).admin, ["a"], ORG)).size).toBe(0);
  });

  it("mapWithLimit keeps order and rejects when a call does", async () => {
    expect(await mapWithLimit([3, 1, 2], 2, async (n) => { await new Promise((done) => setTimeout(done, n)); return n * 2; })).toEqual([6, 2, 4]);
    await expect(mapWithLimit([1, 2], 2, async (n) => { if (n === 2) throw new Error("x"); return n; })).rejects.toThrow("x");
    expect(await mapWithLimit([], 8, async (n) => n)).toEqual([]);
  });
});

describe("093: protectedStates", () => {
  const ctx = {} as never;
  it("lists protected and unanswerable rows, skips ordinary ones, support rows and oneself", async () => {
    const asked: string[] = [];
    const answers: Record<string, boolean | null> = { owner: true, plain: false, broken: null };
    const result = await protectedStates(ctx, [
      { user_id: "owner", support: false }, { user_id: "plain", support: false }, { user_id: "broken", support: false },
      { user_id: "support", support: true }, { user_id: "self", support: false },
    ], "self", async (_ctx, id) => { asked.push(id); return answers[id]; });
    expect(result).toEqual([{ user_id: "owner", state: "protected" }, { user_id: "broken", state: "check_unavailable" }]);
    expect(asked.sort()).toEqual(["broken", "owner", "plain"]);
  });
});
