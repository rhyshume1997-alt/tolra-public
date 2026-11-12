/**
 * Customers module: server entry for the admin / office actions that link a job or quote to a customer (release 153).
 * Path: app/api/customers/document-links/route.ts. POST { action, ... } with action link | override | verify | unlink | retire | portal_set.
 *
 * Inputs: the caller's own session (cookie); a JSON body validated here. Never a company id from the body.
 * Outputs: the lib/customers/document-links.ts result as JSON; 401 not signed in; 403 refused (security refusals are logged, five safe
 * fields only, lib/customers/document-link-refusal.ts); 400 for a bad request (validation: not logged as a security event).
 * Enforced here, not only by the database: signed-in active profile (requireProfile), role (admin for override, retire and portal; admin
 * or office for the rest), no support session, an authenticator code under 15 minutes old (requireRecentAal2; portal OFF needs none, as
 * the database), and the job / quote / customer must belong to the caller's company (checked through the caller's own client with the
 * company filter). The database then applies its own rules unchanged (same exceptions, all-or-nothing rollback).
 * Must not change: no service role, no change to lib/server/auth.ts; never log reasons, codes, ids of documents or customers, names.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  DocumentLinkError, linkDocumentCustomer, linkDocumentCustomerNameOverride, retireDocumentCustomerLinks, setCustomerPortalEnabled,
  unlinkDocumentCustomer, verifyDocumentCustomerLinks,
} from "@/lib/customers/document-links";
import { type LinkAction, type RefusalCategory, logLinkRefusal, securityRefusalCategory } from "@/lib/customers/document-link-refusal";
import { requireRecentAal2 } from "@/lib/server/admin-users";
import { type AuthContext, forbiddenOrigin, isErrorResponse, jsonError, mfaRecentRequired, mfaRequired, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const id = z.string().uuid();
const reason = z.string();
const kind = z.enum(["job", "quote"]);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), kind, documentId: id, customerId: id, reason }).strict(),
  z.object({ action: z.literal("override"), kind, documentId: id, customerId: id, reason, identityConfirmed: z.boolean() }).strict(),
  z.object({ action: z.literal("verify"), linkIds: z.array(z.string().min(1).max(64)).max(1000), reason }).strict(),
  z.object({ action: z.literal("unlink"), kind, documentId: id, reason }).strict(),
  z.object({ action: z.literal("retire"), targetKind: z.enum(["job", "quote", "customer"]), targetId: id, reason }).strict(),
  z.object({ action: z.literal("portal_set"), enabled: z.boolean(), reason }).strict(),
]);
type Body = z.infer<typeof bodySchema>;

const ADMIN_ONLY: readonly LinkAction[] = ["override", "retire", "portal_set"];
const TABLE = { job: "jobs", quote: "quotes", customer: "customers" } as const;
/** Refusals the lib raises itself before any database call: safe to show as written. */
const VALIDATION: readonly string[] = ["reason_required", "invalid_kind", "invalid_batch", "identity_not_confirmed"];

function refused(auth: AuthContext, action: LinkAction, category: RefusalCategory, response: NextResponse) {
  logLinkRefusal({ organizationId: auth.profile.organization_id, actorId: auth.user.id, action, category });
  return response;
}

/** True when the row exists in the caller's own company (the company filter is ours; row security is the database's). null on a read error. */
async function inCompany(auth: AuthContext, target: keyof typeof TABLE, rowId: string): Promise<boolean | null> {
  const { data, error } = await auth.supabase.from(TABLE[target]).select("id").eq("id", rowId).eq("organization_id", auth.profile.organization_id).maybeSingle();
  if (error) return null;
  return Boolean(data);
}

function targets(body: Body): Array<[keyof typeof TABLE, string]> {
  switch (body.action) {
    case "link": case "override": return [[body.kind, body.documentId], ["customer", body.customerId]];
    case "unlink": return [[body.kind, body.documentId]];
    case "retire": return [[body.targetKind, body.targetId]];
    default: return [];
  }
}

async function run(auth: AuthContext, body: Body) {
  const db = auth.supabase;
  switch (body.action) {
    case "link": return linkDocumentCustomer(db, body);
    case "override": return linkDocumentCustomerNameOverride(db, body);
    case "verify": return verifyDocumentCustomerLinks(db, body);
    case "unlink": return unlinkDocumentCustomer(db, body);
    case "retire": return retireDocumentCustomerLinks(db, body);
    case "portal_set": return setCustomerPortalEnabled(db, body);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile();
  if (isErrorResponse(auth)) return auth;

  const json = await readJson(request, 64 * 1024);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const body = parsed.data;
  const action = body.action;

  // Authorisation: support sessions never; admin (override, retire, portal) or admin / office (the rest).
  if (auth.session?.support) return refused(auth, action, "support_session", jsonError("Forbidden", 403));
  const held = [auth.profile.role, auth.profile.secondary_role];
  const allowed = ADMIN_ONLY.includes(action) ? ["admin"] : ["admin", "office"];
  if (!held.some(r => r && allowed.includes(r))) return refused(auth, action, "role", jsonError("Forbidden", 403));

  // Recent authenticator code (portal OFF never needs one).
  if (!(action === "portal_set" && body.enabled === false)) {
    const stale = await requireRecentAal2(auth, "change customer links", true);
    if (stale) {
      const code = (await stale.clone().json().catch(() => ({}))) as { code?: string };
      return refused(auth, action, code.code === "mfa_recent_required" ? "mfa_recent" : "mfa", stale);
    }
  }

  // Company isolation: every job, quote and customer named must belong to the caller's company.
  for (const [target, rowId] of targets(body)) {
    const found = await inCompany(auth, target, rowId);
    if (found === null) return jsonError("Service unavailable", 503);
    if (!found) return refused(auth, action, "other_company", jsonError("Forbidden", 403));
  }

  try {
    return NextResponse.json(await run(auth, body));
  } catch (err) {
    if (!(err instanceof DocumentLinkError)) return jsonError("Service unavailable", 503);
    const category = securityRefusalCategory(err.code);
    if (category === "mfa") return refused(auth, action, category, mfaRequired());
    if (category === "mfa_recent") return refused(auth, action, category, mfaRecentRequired("change customer links"));
    if (category) return refused(auth, action, category, jsonError("Forbidden", 403));
    if (VALIDATION.includes(err.code)) return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    if (err.code === "unknown") return jsonError("Service unavailable", 503);
    return NextResponse.json({ error: "This change was not accepted.", code: err.code }, { status: err.code.endsWith("_not_found") ? 404 : 409 });
  }
}
