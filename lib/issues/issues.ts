// Raise an issue / owner issues inbox: the pure rules (no React, no I/O). Inputs: what a person typed, the company's hidden_nav list,
// filters from the owner's screen, and the rows or errors the database gives back (release 165). Outputs: checked values, fixed wording
// and whitelisted row shapes. Must not change: the marker text 'issues:on' (stored in companies' settings), the default of OFF, the
// urgent wording and phone number, the limits (they mirror release 165's constraints), and that no database message is ever shown.
// The authorisation lives in the database (row security, platform_* functions) and in the owner routes, never here.

/** Stored in hidden_nav when Raise an issue is switched on for a company. Absent (the default) means off. */
export const ISSUES_ON_MARKER = "issues:on";

/** On only when the marker is present. */
export function issuesEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(ISSUES_ON_MARKER));
}

/** The hidden_nav change that switches Raise an issue on or off for a company. */
export function issuesSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [ISSUES_ON_MARKER], remove: [] } : { add: [], remove: [ISSUES_ON_MARKER] };
}

export const OWNER_PHONE_DISPLAY = "07908041480";
/** Shown when "urgent" is ticked. The issue is still saved. */
export const URGENT_CALL_MESSAGE = `Call Rhys on ${OWNER_PHONE_DISPLAY}`;

export const ISSUE_PAGE_MAX = 300;
export const ISSUE_BODY_MAX = 2000;
export const OWNER_NOTES_MAX = 4000;
export const PR_URL_MAX = 500;

export const ISSUE_STATUSES = ["new", "looking", "fixing", "fixed", "closed"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = { new: "New", looking: "Looking", fixing: "Fixing", fixed: "Fixed", closed: "Closed" };

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page an issue is about: the path only (a query string can carry tokens), at most 300 characters, "/" when empty. */
export function issuePageFrom(pathname: string | null | undefined): string {
  const path = (pathname ?? "").split(/[?#]/)[0].trim();
  return (path || "/").slice(0, ISSUE_PAGE_MAX);
}

export type RaiseIssueInput = { page: string; body: string; urgent: boolean };
export type RaiseIssueCheck = { ok: true; value: RaiseIssueInput } | { ok: false; field: "page" | "body"; error: string };

/** What the form sends to raise_issue: text trimmed, both fields required, limits as the database's. */
export function checkRaiseIssue(input: { page: string; body: string; urgent: boolean }): RaiseIssueCheck {
  const body = input.body.trim();
  const page = input.page.trim();
  if (!body) return { ok: false, field: "body", error: "Tell us what went wrong." };
  if (body.length > ISSUE_BODY_MAX) return { ok: false, field: "body", error: `Keep it to ${ISSUE_BODY_MAX} characters or fewer.` };
  if (!page) return { ok: false, field: "page", error: "Say which page this is about." };
  if (page.length > ISSUE_PAGE_MAX) return { ok: false, field: "page", error: `Keep the page to ${ISSUE_PAGE_MAX} characters or fewer.` };
  return { ok: true, value: { page, body, urgent: input.urgent === true } };
}

/** Fixed wording for what raise_issue refused. The database's own message is never shown. */
export function raiseIssueRefusal(error: { code?: string | null; hint?: string | null } | null | undefined): string {
  if (error?.hint === "issues_off") return "Raising an issue isn't switched on for your company.";
  if (error?.hint === "too_many") return "You've raised a lot of issues in the last hour. Please try again later, or call if it's urgent.";
  if (error?.code === "42501") return "You can't raise an issue from here. A support session is read-only.";
  if (error?.code === "22023") return "Check what you wrote and try again.";
  return "Couldn't send your issue. Nothing was saved; try again.";
}

// ---- The owner's inbox ---------------------------------------------------------------------------------------------------------

export type OwnerIssue = {
  id: string; organizationId: string; organizationName: string; raisedByName: string | null; raisedByEmail: string | null;
  page: string; body: string; urgent: boolean; status: IssueStatus; createdAt: string; updatedAt: string; closedAt: string | null;
  ownerNotes: string; prUrl: string | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** One row from platform_list_issues, whitelisted. Null when it is not the expected shape (such a row is dropped, never guessed). */
export function parseOwnerIssue(row: unknown): OwnerIssue | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = str(r.issue_id), organizationId = str(r.organization_id), organizationName = str(r.organization_name);
  const page = str(r.page), body = str(r.body), createdAt = str(r.created_at), updatedAt = str(r.updated_at);
  if (!id || !organizationId || organizationName === null || page === null || body === null || !createdAt || !updatedAt) return null;
  if (!isIssueStatus(r.status) || typeof r.urgent !== "boolean") return null;
  return {
    id, organizationId, organizationName, raisedByName: str(r.raised_by_name), raisedByEmail: str(r.raised_by_email), page, body,
    urgent: r.urgent, status: r.status, createdAt, updatedAt, closedAt: str(r.closed_at), ownerNotes: str(r.owner_notes) ?? "", prUrl: str(r.pr_url),
  };
}

export type OwnerIssueFilters = { organizationId: string | null; status: IssueStatus | null; urgent: boolean | null };
export type FilterCheck = { ok: true; value: OwnerIssueFilters } | { ok: false; error: string };

/** Filters from the query string: company (uuid), status, urgent ("true" or "false"). Anything else is refused, never ignored. */
export function checkIssueFilters(params: URLSearchParams): FilterCheck {
  const org = params.get("org") || null;
  const status = params.get("status") || null;
  const urgent = params.get("urgent") || null;
  if (org !== null && !UUID.test(org)) return { ok: false, error: "Choose a company from the list." };
  if (status !== null && !isIssueStatus(status)) return { ok: false, error: "Choose a status from the list." };
  if (urgent !== null && urgent !== "true" && urgent !== "false") return { ok: false, error: "Urgent must be yes or no." };
  return { ok: true, value: { organizationId: org ? org.toLowerCase() : null, status, urgent: urgent === null ? null : urgent === "true" } };
}

export type OwnerIssueUpdate = { id: string; status: IssueStatus; notes: string; prUrl: string | null };
export type UpdateCheck = { ok: true; value: OwnerIssueUpdate } | { ok: false; error: string };

/** PATCH body of the owner route: { id, status, notes, prUrl }. Unknown keys are refused. The PR link must be an https address. */
export function checkOwnerUpdate(body: unknown): UpdateCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Choose an issue and a status." };
  const { id, status, notes, prUrl, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return { ok: false, error: "Choose an issue and a status." };
  if (typeof id !== "string" || !UUID.test(id.trim())) return { ok: false, error: "Choose an issue from the list." };
  if (!isIssueStatus(status)) return { ok: false, error: "Choose a status from the list." };
  if (notes !== undefined && typeof notes !== "string") return { ok: false, error: "Notes must be text." };
  if (prUrl !== undefined && prUrl !== null && typeof prUrl !== "string") return { ok: false, error: "The PR link must be text." };
  const cleanNotes = typeof notes === "string" ? notes : "";
  if (cleanNotes.length > OWNER_NOTES_MAX) return { ok: false, error: `Keep the notes to ${OWNER_NOTES_MAX} characters or fewer.` };
  const link = typeof prUrl === "string" ? prUrl.trim() : "";
  if (link && (link.length > PR_URL_MAX || !/^https:\/\/\S+$/.test(link))) return { ok: false, error: "The PR link must be a web address starting with https://." };
  return { ok: true, value: { id: id.trim().toLowerCase(), status, notes: cleanNotes, prUrl: link || null } };
}

export type OwnerRefusal = { status: number; error: string; code?: string };

/** Fixed wording for what a platform_* function refused. `mfa_required` keeps its code so the browser can go to the code page. */
export function ownerIssueRefusal(error: { code?: string | null; hint?: string | null } | null | undefined): OwnerRefusal {
  if (error?.code === "42501") return error.hint === "mfa_required" ? { status: 403, code: "mfa_required", error: "Confirm your authenticator code first." } : { status: 403, error: "Forbidden" };
  if (error?.code === "P0002") return { status: 404, error: "That issue was not found." };
  if (error?.code === "22023") return { status: 400, error: "Check the status, notes and PR link and try again." };
  return { status: 500, error: "Couldn't do that. Nothing was changed; try again." };
}
