/**
 * Customers module: the security-refusal log line for the customer document-link route (release 153).
 * Path: lib/customers/document-link-refusal.ts. Used only by app/api/customers/document-links/route.ts (server side).
 *
 * Inputs: which security check refused (a category), the company id, the actor id and the action name.
 * Outputs: one console.warn line in the server log style ("[customers] link refused:") with EXACTLY five fields: organization_id,
 * actor_id, action, at (ISO time), category. Nothing else is ever added.
 * Must not change: never log reasons, authenticator codes, credentials, error codes or messages, document or customer ids, names or
 * any document field. Validation refusals (empty reason, bad kind, ...) are not security events and are never logged; success logs nothing.
 */
import type { DocumentLinkErrorCode } from "@/lib/customers/document-links";

export type LinkAction = "link" | "override" | "verify" | "unlink" | "retire" | "portal_set";
export type RefusalCategory = "role" | "support_session" | "mfa" | "mfa_recent" | "other_company";

const SECURITY_CATEGORY: Partial<Record<DocumentLinkErrorCode, RefusalCategory>> = {
  admin_required: "role",
  admin_or_office_required: "role",
  mfa_required: "mfa",
  mfa_recent_required: "mfa_recent",
  link_other_company: "other_company",
};

/** The category when the database refused for a security reason; null for every other (validation or business) refusal. */
export function securityRefusalCategory(code: DocumentLinkErrorCode): RefusalCategory | null {
  return SECURITY_CATEGORY[code] ?? null;
}

export function logLinkRefusal(input: { organizationId: string; actorId: string; action: LinkAction; category: RefusalCategory; now?: Date }): void {
  const line = {
    organization_id: String(input.organizationId),
    actor_id: String(input.actorId),
    action: input.action,
    at: (input.now ?? new Date()).toISOString(),
    category: input.category,
  };
  console.warn("[customers] link refused:", JSON.stringify(line));
}
