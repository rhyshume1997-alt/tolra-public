/**
 * Inputs: service-role admin client, orgId, userId, creation/membership flags, and optional prior membership snapshot.
 * Outputs: verified rollback outcome (`ok`, `membershipCleared`, `authDeleted`) plus uncertain-state error copy.
 * Boundary: Module 1 (Admin Users) only; compensates partial writes in POST /api/admin/users without changing DB schema.
 */
import "server-only";

import type { AdminContext } from "@/lib/server/admin-users";

const BAN_FOREVER = "876000h";

export const CREATE_ROLLBACK_UNCERTAIN_MESSAGE =
  "Could not finish creating the user, and cleanup could not be confirmed. Refresh Users and check whether the account or access needs to be removed.";

export type PriorMembershipSnapshot = {
  active: boolean;
  role?: string;
  secondary_role?: string | null;
  hidden_sections?: string[];
};

export type CreateRollbackInput = {
  admin: AdminContext["admin"];
  orgId: string;
  userId: string;
  created: boolean;
  memberAdded: boolean;
  reactivating: boolean;
  priorMembership: PriorMembershipSnapshot | null;
  restoredBanOrg?: string | null;
};

export type CreateRollbackResult = {
  ok: boolean;
  membershipCleared: boolean;
  authDeleted: boolean;
};

function isMissingAuthUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { status?: unknown; code?: unknown; message?: unknown };
  if (record.status === 404 || record.code === "user_not_found") return true;
  return typeof record.message === "string" && /user not found|not found/i.test(record.message);
}

function sameStringArray(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const left = [...a.map(String)].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

async function readMembershipRow(admin: AdminContext["admin"], orgId: string, userId: string) {
  try {
    const { data, error } = await admin
      .from("organization_members")
      .select("role, secondary_role, active, hidden_sections")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) return { ok: false as const, row: null };
    return { ok: true as const, row: (data as Record<string, unknown> | null) ?? null };
  } catch {
    return { ok: false as const, row: null };
  }
}

async function clearOrRestoreMembership(input: CreateRollbackInput): Promise<boolean> {
  const { admin, orgId, userId, reactivating, priorMembership } = input;
  if (!input.memberAdded) return true;

  if (reactivating) {
    const restorePatch: Record<string, unknown> = { active: false };
    if (priorMembership?.role !== undefined) restorePatch.role = priorMembership.role;
    if (priorMembership?.secondary_role !== undefined) restorePatch.secondary_role = priorMembership.secondary_role;
    if (priorMembership?.hidden_sections !== undefined) restorePatch.hidden_sections = priorMembership.hidden_sections;

    try {
      const { error } = await admin
        .from("organization_members")
        .update(restorePatch)
        .eq("user_id", userId)
        .eq("organization_id", orgId);
      if (error) console.error("[admin/users] rollback membership restore failed", error.code ?? "no-code");
    } catch {
      console.error("[admin/users] rollback membership restore threw");
    }

    const verified = await readMembershipRow(admin, orgId, userId);
    if (!verified.ok || !verified.row) return false;
    if (verified.row.active !== false) return false;
    if (priorMembership?.role !== undefined && verified.row.role !== priorMembership.role) return false;
    if (priorMembership?.secondary_role !== undefined && (verified.row.secondary_role ?? null) !== priorMembership.secondary_role) return false;
    if (priorMembership?.hidden_sections !== undefined && !sameStringArray(verified.row.hidden_sections, priorMembership.hidden_sections)) return false;
    return true;
  }

  try {
    const { error } = await admin
      .from("organization_members")
      .delete()
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    if (error) console.error("[admin/users] rollback membership delete failed", error.code ?? "no-code");
  } catch {
    console.error("[admin/users] rollback membership delete threw");
  }

  const verified = await readMembershipRow(admin, orgId, userId);
  return verified.ok && verified.row === null;
}

async function verifyAuthUserDeleted(admin: AdminContext["admin"], userId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) return isMissingAuthUserError(error);
    return !data?.user;
  } catch {
    return false;
  }
}

async function restoreLiftedBan(admin: AdminContext["admin"], userId: string, markerOrg: string | null): Promise<boolean> {
  try {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: BAN_FOREVER,
      app_metadata: { deactivation_ban: true, deactivation_ban_org: markerOrg },
    });
    if (error) {
      console.error("[admin/users] rollback ban restore failed", error.status ?? "no-status");
      return false;
    }
    return true;
  } catch {
    console.error("[admin/users] rollback ban restore threw");
    return false;
  }
}

/**
 * Reverts partial writes made during POST /api/admin/users and verifies the resulting state:
 * - New logins: revokes any inserted organization_members row first, deletes the Auth user, and reads back Auth to confirm deletion.
 * - Existing logins: removes the newly added membership row (or restores the prior inactive row on reactivation) and restores a lifted ban.
 */
export async function rollbackUserCreation(input: CreateRollbackInput): Promise<CreateRollbackResult> {
  const { admin, userId, created } = input;

  if (!created) {
    const membershipCleared = await clearOrRestoreMembership(input);
    const banRestored = input.restoredBanOrg !== undefined
      ? await restoreLiftedBan(admin, userId, input.restoredBanOrg)
      : true;
    return {
      ok: membershipCleared && banRestored,
      membershipCleared,
      authDeleted: false,
    };
  }

  // Clear company access before deleting Auth so a failed deleteUser cannot leave an unrestricted active member.
  let membershipCleared = await clearOrRestoreMembership(input);

  let deleteFailed = false;
  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      deleteFailed = true;
      console.error("[admin/users] rollback deleteUser failed", error.status ?? error.code ?? "no-code");
    }
  } catch {
    deleteFailed = true;
    console.error("[admin/users] rollback deleteUser threw");
  }

  const authDeleted = await verifyAuthUserDeleted(admin, userId);
  if (!authDeleted && !deleteFailed) {
    console.error("[admin/users] rollback deleteUser could not be confirmed");
  }

  // If Auth deletion succeeded, cascade may also have removed organization_members; re-verify if step 1 failed.
  if (authDeleted && !membershipCleared) {
    const verified = await readMembershipRow(admin, input.orgId, userId);
    membershipCleared = verified.ok && verified.row === null;
  }

  return {
    ok: authDeleted && membershipCleared,
    membershipCleared,
    authDeleted,
  };
}
