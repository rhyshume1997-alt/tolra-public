// Platform owner Companies panel (Owner Console, module 12). Inputs: the raw rows release 164's platform_company_overview() returns, the raw
// JSON body of POST /api/platform/companies/status, and the error release 164's platform_set_organization_status() returned. Outputs: numbers
// parsed from the database's bigint strings, a checked input, and fixed-wording refusals. Must not change: nothing here deletes anything (Close
// only sets a company's status), no database message is ever shown to the caller, the panel is OFF unless PLATFORM_COMPANIES_ENABLED is exactly
// "true", and the authorisation lives in the route and the database, not here. Pure (no React, no I/O).

export const PLATFORM_COMPANIES_ENV_FLAG = "PLATFORM_COMPANIES_ENABLED";
export const STATUS_REASON_MIN = 5;
export const STATUS_REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** On only when the env var is exactly "true". Read on the server only. */
export function platformCompaniesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PLATFORM_COMPANIES_ENV_FLAG] === "true";
}

export type CompanyRow = {
  organizationId: string; name: string; slug: string; status: string;
  people: number; jobs: number; invoices: number; issuedInvoices: number;
};

const count = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/** The database's rows, whitelisted. A row that is not the expected shape is dropped. */
export function parseOverview(data: unknown): CompanyRow[] {
  if (!Array.isArray(data)) return [];
  const rows: CompanyRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    if (typeof d.organization_id !== "string" || typeof d.name !== "string" || typeof d.slug !== "string" || typeof d.status !== "string") continue;
    rows.push({ organizationId: d.organization_id, name: d.name, slug: d.slug, status: d.status, people: count(d.user_count), jobs: count(d.job_count), invoices: count(d.invoice_count), issuedInvoices: count(d.issued_invoice_count) });
  }
  return rows;
}

export type StatusInput = { organizationId: string; status: "closed" | "active"; confirmName: string; reason: string };
export type StatusCheck = { ok: true; value: StatusInput } | { ok: false; error: string };

/** A company id, closed or active, a reason of 5 to 500 characters, and (to close) the typed name. Unknown keys are refused. */
export function checkStatusInput(body: unknown): StatusCheck {
  const bad = (error: string): StatusCheck => ({ ok: false, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Choose a company and give a reason.");
  const { organizationId, status, confirmName, reason, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return bad("Choose a company and give a reason.");
  if (typeof organizationId !== "string" || !UUID.test(organizationId.trim())) return bad("Choose a company from the list.");
  if (status !== "closed" && status !== "active") return bad("Choose close or reopen.");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < STATUS_REASON_MIN) return bad(`Give a reason of at least ${STATUS_REASON_MIN} characters.`);
  if (why.length > STATUS_REASON_MAX) return bad(`Keep the reason to ${STATUS_REASON_MAX} characters or fewer.`);
  const name = typeof confirmName === "string" ? confirmName : "";
  if (status === "closed" && !name.trim()) return bad("Type the company's name to confirm.");
  return { ok: true, value: { organizationId: organizationId.trim().toLowerCase(), status, confirmName: name, reason: why } };
}

export type StatusRefusal = { status: number; error: string; code?: string };

/** Fixed wording for what the database refused. `mfa_recent_required` keeps its code so the browser can ask for a fresh code. */
export function statusRefusal(error: { code?: string | null; hint?: string | null } | null | undefined): StatusRefusal {
  const hint = error?.hint ?? "";
  if (error?.code === "42501") {
    if (hint === "mfa_recent_required") return { status: 403, code: "mfa_recent_required", error: "For your security, enter a fresh code from your authenticator app to close a company." };
    if (hint === "mfa_required") return { status: 403, code: "mfa_required", error: "Confirm your authenticator code first." };
    return { status: 403, error: "Forbidden" };
  }
  if (error?.code === "P0002") return { status: 404, error: "That company was not found." };
  if (error?.code === "22023") {
    if (hint === "name_mismatch") return { status: 400, error: "The name you typed does not match this company. Nothing was changed." };
    if (hint === "reason_required") return { status: 400, error: `Give a reason of ${STATUS_REASON_MIN} to ${STATUS_REASON_MAX} characters.` };
    if (hint === "inside_company") return { status: 409, error: "You are inside this company. Leave it first, then close it." };
    if (hint === "status_transition") return { status: 409, error: "Only an active company can be closed, and a closed one reopened." };
    return { status: 400, error: "That request was not accepted. Nothing was changed." };
  }
  return { status: 500, error: "Couldn't change the company. Nothing was changed; try again." };
}

export type StatusResult = { organizationId: string; status: string; changed: boolean };

/** The database's answer, whitelisted. Null when it is not the expected shape. */
export function parseStatusResult(data: unknown): StatusResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.organization_id !== "string" || typeof d.status !== "string" || typeof d.changed !== "boolean") return null;
  return { organizationId: d.organization_id, status: d.status, changed: d.changed };
}
