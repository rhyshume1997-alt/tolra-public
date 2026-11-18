import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, mfaRecentRequired } from "@/lib/server/auth";

/**
 * BOUNDARY: lib/portal/staff.ts (module 10, customer portal, staff side). Server-only.
 * INPUTS: the signed-in ADMIN's own Supabase client (requireProfile(["admin"]).supabase; never the service role) and the admin's typed values.
 * OUTPUTS: StaffResult<T>: the parsed answer, or a fixed message with an HTTP status. Calls only release 153's customer_portal_status and
 * customer_portal_set_enabled, and release 154's portal_contacts_list, portal_contact_invite and portal_contact_revoke (argument names and
 * types as those functions declare them). Database hints map to the fixed messages below; the database's own text is never passed on.
 * A stale authenticator code (hint mfa_recent_required) comes back as `mfaRecent`, which the route turns into mfaRecentRequired(action).
 * NEVER logs or returns an e-mail address, name, reason or database message. Must not use the service role, change the portal's
 * customer side (lib/portal/server.ts) or weaken a database check: the functions repeat admin, second-step and company checks themselves.
 */

export type StaffFailure = { ok: false; status: number; message: string; mfaRecent?: true };
export type StaffResult<T> = { ok: true; data: T } | StaffFailure;

export const PORTAL_INVITE_ACTION = "invite a portal contact";
export const PORTAL_SWITCH_ACTION = "switch the customer portal on";

/** Fixed message per database hint. Anything else gets GENERIC. */
const HINT_MESSAGES: Record<string, { status: number; message: string }> = {
  admin_required: { status: 403, message: "Only your company's admin can do this." },
  portal_off: { status: 409, message: "The customer portal is off for your company: switch it on first." },
  customer_not_found: { status: 404, message: "That customer isn't in your company." },
  customer_archived: { status: 409, message: "That customer is archived." },
  invalid_email: { status: 400, message: "Enter a valid e-mail address." },
  invalid_name: { status: 400, message: "Enter the person's name (up to 120 characters)." },
  invalid_permissions: { status: 400, message: "Choose what the person may see: quotes, jobs or both." },
  invalid_enabled: { status: 400, message: "Choose on or off." },
  reason_required: { status: 400, message: "Give a reason (up to 500 characters)." },
  already_invited: { status: 409, message: "That e-mail is already a portal contact of this customer." },
  contact_not_found: { status: 404, message: "That portal contact isn't in your company." },
  already_revoked: { status: 409, message: "That portal contact is already revoked." },
};
const GENERIC: StaffFailure = { ok: false, status: 409, message: "Nothing was changed. Check your admin sign-in and try again." };
const UNAVAILABLE: StaffFailure = { ok: false, status: 503, message: "The customer portal settings are not available. Nothing was changed." };
const INVALID: StaffFailure = { ok: false, status: 400, message: "Check the details and try again." };

/** Maps a database error to a fixed failure. Reads only `hint` and `code`, never `message` or `details`. */
export function mapStaffError(error: { hint?: string | null; code?: string | null }): StaffFailure {
  const hint = error.hint ?? "";
  if (hint === "mfa_recent_required") return { ok: false, status: 403, message: "Enter a fresh code from your authenticator app first.", mfaRecent: true };
  const known = Object.hasOwn(HINT_MESSAGES, hint) ? HINT_MESSAGES[hint] : undefined;
  if (known) return { ok: false, ...known };
  if (error.code === "42501") return { ok: false, status: 403, message: "Only your company's admin can do this." };
  return GENERIC;
}

const reasonSchema = z.string().trim().min(1).max(500);
export const portalSwitchInputSchema = z.object({ enabled: z.boolean(), reason: reasonSchema }).strict();
export const portalInviteInputSchema = z.object({
  customerId: z.string().uuid(),
  email: z.string().trim().min(3).max(254),
  name: z.string().trim().min(1).max(120),
  permissions: z.array(z.enum(["quotes", "jobs"])).min(1).max(2),
  reason: reasonSchema,
}).strict();
export const portalRevokeInputSchema = z.object({ reason: reasonSchema }).strict();
export const portalIdSchema = z.string().uuid();

export type PortalStatus = { enabled: boolean; changedAt: string | null };
export type PortalContactRow = {
  contactId: string; email: string; displayName: string; permissions: Array<"quotes" | "jobs">;
  invitedAt: string; invitedBy: string | null; revokedAt: string | null; liveSessions: number;
};

const statusRaw = z.object({ enabled: z.boolean(), changed_at: z.string().nullable().optional() }).strict();
const contactRaw = z.object({
  contact_id: z.string(), email: z.string(), display_name: z.string(), permissions: z.array(z.enum(["quotes", "jobs"])),
  invited_at: z.string(), invited_by: z.string().nullable(), revoked_at: z.string().nullable(), live_sessions: z.number().int().min(0),
}).strict();
const invitedRaw = z.object({ contact_id: z.string(), customer_id: z.string(), permissions: z.array(z.enum(["quotes", "jobs"])) }).strict();
const revokedRaw = z.object({ contact_id: z.string(), revoked_at: z.string(), ended_sessions: z.number().int().min(0) }).strict();

async function call<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown> | undefined, schema: z.ZodType<T>): Promise<StaffResult<T>> {
  try {
    const { data, error } = args === undefined ? await supabase.rpc(fn) : await supabase.rpc(fn, args);
    if (error) return mapStaffError(error as { hint?: string | null; code?: string | null });
    const parsed = schema.safeParse(data);
    return parsed.success ? { ok: true, data: parsed.data } : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/** The company's portal switch. No row means off. */
export async function getPortalStatus(supabase: SupabaseClient): Promise<StaffResult<PortalStatus>> {
  const r = await call(supabase, "customer_portal_status", undefined, statusRaw);
  return r.ok ? { ok: true, data: { enabled: r.data.enabled, changedAt: r.data.changed_at ?? null } } : r;
}

/** Switch the portal on (needs a fresh authenticator code) or off (never waits for one). */
export async function setPortalEnabled(supabase: SupabaseClient, input: unknown): Promise<StaffResult<PortalStatus>> {
  const p = portalSwitchInputSchema.safeParse(input);
  if (!p.success) return INVALID;
  const r = await call(supabase, "customer_portal_set_enabled", { p_enabled: p.data.enabled, p_reason: p.data.reason }, statusRaw);
  return r.ok ? { ok: true, data: { enabled: r.data.enabled, changedAt: r.data.changed_at ?? null } } : r;
}

export async function listPortalContacts(supabase: SupabaseClient, customerId: unknown): Promise<StaffResult<PortalContactRow[]>> {
  const id = portalIdSchema.safeParse(customerId);
  if (!id.success) return INVALID;
  const r = await call(supabase, "portal_contacts_list", { p_customer: id.data }, z.array(contactRaw));
  if (!r.ok) return r;
  return { ok: true, data: r.data.map((k) => ({
    contactId: k.contact_id, email: k.email, displayName: k.display_name, permissions: k.permissions, invitedAt: k.invited_at,
    invitedBy: k.invited_by, revokedAt: k.revoked_at, liveSessions: k.live_sessions,
  })) };
}

export async function invitePortalContact(supabase: SupabaseClient, input: unknown): Promise<StaffResult<{ contactId: string; customerId: string; permissions: Array<"quotes" | "jobs"> }>> {
  const p = portalInviteInputSchema.safeParse(input);
  if (!p.success) return INVALID;
  const r = await call(supabase, "portal_contact_invite", {
    p_customer: p.data.customerId, p_email: p.data.email, p_name: p.data.name, p_permissions: p.data.permissions, p_reason: p.data.reason,
  }, invitedRaw);
  return r.ok ? { ok: true, data: { contactId: r.data.contact_id, customerId: r.data.customer_id, permissions: r.data.permissions } } : r;
}

export async function revokePortalContact(supabase: SupabaseClient, contactId: unknown, input: unknown): Promise<StaffResult<{ contactId: string; revokedAt: string; endedSessions: number }>> {
  const id = portalIdSchema.safeParse(contactId);
  const p = portalRevokeInputSchema.safeParse(input);
  if (!id.success || !p.success) return INVALID;
  const r = await call(supabase, "portal_contact_revoke", { p_contact: id.data, p_reason: p.data.reason }, revokedRaw);
  return r.ok ? { ok: true, data: { contactId: r.data.contact_id, revokedAt: r.data.revoked_at, endedSessions: r.data.ended_sessions } } : r;
}

/** The route's answer: the data (no-store), the fresh-code request, or the fixed message. `action` words the fresh-code request. */
export function staffReply<T>(result: StaffResult<T>, action: string, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: successStatus, headers: { "Cache-Control": "no-store" } });
  if (result.mfaRecent) return mfaRecentRequired(action);
  return jsonError(result.message, result.status);
}
