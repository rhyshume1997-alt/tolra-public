import "server-only";

import { type AdminContext, type BanState, banState, loginIsProtected } from "@/lib/server/admin-users";
import type { ProtectedState, SignInState } from "@/lib/sign-in-access";

// The GET behind Admin > Users' sign-in badges (app/api/admin/users/sign-in). It used to ask, member by member and one after the other,
// "does this login belong to this company alone?" (one query each) and "is it banned?" (one Auth lookup each): slow for a long list.
// Now one query answers the first for everyone, and the Auth lookups run side by side, a few at a time. Same answer, same order.

/** How many Auth lookups run at once: enough to be quick, few enough not to hammer Auth. */
export const BAN_LOOKUP_CONCURRENCY = 8;

/** For a login that belongs to `orgId` alone: "off" only when a marked ban this company may lift stops it. */
export function stateOf(ban: BanState | null, orgId: string): SignInState {
  if (!ban) return "unknown";
  if (!ban.banned) return "on";
  // A legacy marker (no company) counts as this company's here, as the login has no other company. Another company's marker and the
  // platform owner's ban can be lifted only by Tolra support.
  return ban.appBan && (ban.banOrg === null || ban.banOrg === orgId) ? "off" : "off_platform";
}

/**
 * Which of `userIds` belong to `orgId` alone (every membership of the login is in `orgId`, as ownsIdentity decides for one), from ONE
 * read of their memberships. A login with no membership row, or a read that fails, is not owned (as ownsIdentity answered).
 */
export async function loginsOwnedBy(admin: AdminContext["admin"], userIds: string[], orgId: string): Promise<Set<string>> {
  const owned = new Set<string>();
  if (!userIds.length) return owned;
  const { data, error } = await admin.from("organization_members").select("user_id, organization_id").in("user_id", userIds);
  if (error || !data?.length) return owned;
  const seen = new Map<string, boolean>();
  for (const row of data as Array<{ user_id: string; organization_id: string }>) {
    seen.set(row.user_id, (seen.get(row.user_id) ?? true) && row.organization_id === orgId);
  }
  for (const [userId, onlyHere] of seen) if (onlyHere) owned.add(userId);
  return owned;
}

/** Runs `fn` over `items` with at most `limit` at once; results come back in the order of `items`. A rejection rejects the whole call. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/**
 * The sign-in state of every active, ordinary member (not oneself, not support) whose login belongs to this company alone, in the
 * order the members were read. Anyone else is not listed.
 */
export async function signInStates(
  admin: AdminContext["admin"],
  members: ReadonlyArray<{ user_id: string; active: boolean; support: boolean }>,
  selfId: string,
  orgId: string,
  lookup: (admin: AdminContext["admin"], userId: string) => Promise<BanState | null> = banState,
): Promise<Array<{ user_id: string; sign_in: SignInState }>> {
  const candidates = members.filter((member) => member.active && !member.support && member.user_id !== selfId);
  const owned = await loginsOwnedBy(admin, candidates.map((member) => member.user_id), orgId);
  const listed = candidates.filter((member) => owned.has(member.user_id));
  const bans = await mapWithLimit(listed, BAN_LOOKUP_CONCURRENCY, (member) => lookup(admin, member.user_id));
  return listed.map((member, index) => ({ user_id: member.user_id, sign_in: stateOf(bans[index], orgId) }));
}

/**
 * 093: which members' identity no company admin may touch (a platform owner's login, or one with any support membership), so the page
 * offers them no Edit, Set password, Reset two-step or sign-in control: "protected", or "check_unavailable" when the check can't be
 * answered (fail closed, e.g. before 093 is applied). Every ordinary row (support rows have their own Revoke) but the caller's, asked a
 * few at a time; anyone not listed is ordinary.
 */
export async function protectedStates(
  ctx: AdminContext,
  members: ReadonlyArray<{ user_id: string; support: boolean }>,
  selfId: string,
  check: (ctx: AdminContext, userId: string) => Promise<boolean | null> = loginIsProtected,
): Promise<Array<{ user_id: string; state: ProtectedState }>> {
  const candidates = members.filter((member) => !member.support && member.user_id !== selfId);
  const answers = await mapWithLimit(candidates, BAN_LOOKUP_CONCURRENCY, (member) => check(ctx, member.user_id));
  return candidates.flatMap((member, index) => {
    const answer = answers[index];
    if (answer === false) return [];
    return [{ user_id: member.user_id, state: answer === null ? ("check_unavailable" as const) : ("protected" as const) }];
  });
}
