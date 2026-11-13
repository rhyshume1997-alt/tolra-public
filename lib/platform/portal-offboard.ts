// Platform portal offboarding (go-live feature 5). Inputs: the raw JSON body of POST /api/platform/portal-offboard, and the error
// a call to release 153's platform_offboard_document_customer_links(p_org, p_reason) returned. Outputs: a checked input, fixed-wording
// answers, and the shape of the database's result. Must not change: no database message is ever shown to the caller, nothing here
// deletes a company, a document or a customer, and the authorisation lives in the route and the database, not here.

export const OFFBOARD_REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OffboardInput = { organizationId: string; reason: string };
export type OffboardCheck = { ok: true; value: OffboardInput } | { ok: false; error: string };

/** A company id (uuid) and a non-empty reason of at most 500 characters, or a plain error. Unknown keys are refused. */
export function checkOffboardInput(body: unknown): OffboardCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Choose a company and give a reason." };
  const { organizationId, reason, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return { ok: false, error: "Choose a company and give a reason." };
  if (typeof organizationId !== "string" || !UUID.test(organizationId.trim())) return { ok: false, error: "Choose a company from the list." };
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) return { ok: false, error: "Give a reason." };
  if (trimmed.length > OFFBOARD_REASON_MAX) return { ok: false, error: `Keep the reason to ${OFFBOARD_REASON_MAX} characters or fewer.` };
  return { ok: true, value: { organizationId: organizationId.trim().toLowerCase(), reason: trimmed } };
}

export type OffboardResult = { removedLinks: number; removedSwitch: boolean; organizationId: string };

/** The database's answer, whitelisted. Null when it is not the expected shape. */
export function parseOffboardResult(data: unknown): OffboardResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.removed_links !== "number" || typeof d.removed_switch !== "boolean" || typeof d.organization_id !== "string") return null;
  return { removedLinks: d.removed_links, removedSwitch: d.removed_switch, organizationId: d.organization_id };
}

export type OffboardRefusal = { status: number; error: string; code?: string };

/** Fixed wording for what the database refused. `mfa_recent_required` keeps its code so the browser can ask for a fresh code. */
export function offboardRefusal(error: { code?: string | null; hint?: string | null } | null | undefined): OffboardRefusal {
  if (error?.code === "42501") {
    if (error.hint === "mfa_recent_required") return { status: 403, code: "mfa_recent_required", error: "For your security, enter a fresh code from your authenticator app to remove a company's portal links." };
    if (error.hint === "mfa_required") return { status: 403, code: "mfa_required", error: "Confirm your authenticator code first." };
    if (error.hint === "support_read_only") return { status: 403, error: "A read-only support session cannot do this." };
    return { status: 403, error: "Forbidden" };
  }
  if (error?.code === "P0002" && error.hint === "company_not_found") return { status: 404, error: "That company was not found." };
  if (error?.code === "P0002" && error.hint === "nothing_to_offboard") return { status: 409, error: "That company has no portal links or portal switch to remove." };
  if (error?.code === "22023") return { status: 400, error: "Give a reason of 1 to 500 characters." };
  return { status: 500, error: "Couldn't remove the portal links. Nothing was changed; try again." };
}
