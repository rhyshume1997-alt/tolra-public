/**
 * The company this page was opened for (S5b: company switch mid-form).
 *
 * Two open tabs share one Supabase session, and switch_organization (036) changes THAT session's company. Every write the app makes
 * is filed in the session's company: create_with_lines, create_job and next_doc_number take it from current_user_organization_id(),
 * and the direct inserts read it fresh at submit (lib/supabase-business.ts getCurrentUserAndOrganization). So a form opened in
 * company A, submitted after another tab switched the session to company B, was saved into B, with A's customer and prices; RLS
 * can't catch that, the person is a member of both. (The offline queue already checks this: 090, lib/offline/sync.ts.)
 *
 * lib/use-user.ts records here the company the page loaded under (the session's, from my_session). Before a write, the company the
 * session is in NOW is compared with it, and a difference refuses the write with COMPANY_CHANGED_MESSAGE: nothing is saved anywhere.
 * No company recorded (not signed in to one yet, the company chooser, a test) means nothing to compare: the check passes.
 */

let pageCompany: string | null = null;

/**
 * Set by lib/use-user.ts once the page knows its company (null until then). Never cleared while the page is open: a sign-out, an ended
 * access or a switch in THIS tab reloads the page, and until that reload a write is still held to the company the page was opened for.
 */
export function setPageCompany(organizationId: string | null) {
  pageCompany = organizationId;
}

/** The company this page was opened for, or null when none is known. */
export const currentPageCompany = () => pageCompany;

export const COMPANY_CHANGED_MESSAGE =
  "You have switched company in another tab since this page was opened, so nothing was saved (it would have gone into the other company). Reload the page to work in the company you are in now, or switch back and try again.";

export class CompanyChangedError extends Error {
  readonly code = "company_changed";
  /** lib/friendly-error.ts shows the message for this hint, as it does for the database's own named refusals. */
  readonly hint = "company_changed";
  constructor() {
    super(COMPANY_CHANGED_MESSAGE);
    this.name = "CompanyChangedError";
  }
}

/** Throws CompanyChangedError when the session's company now (the database's answer) is not the company this page was opened for. */
export function assertPageCompany(sessionCompany: string | null | undefined) {
  if (pageCompany !== null && sessionCompany !== pageCompany) throw new CompanyChangedError();
}

type CompanyRpc = { rpc: (fn: "current_user_organization_id") => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * Before a write the database files in the session's company by itself (create_with_lines, create_job, next_doc_number): asks the
 * database which company the session is in now (one request) and refuses, with COMPANY_CHANGED_MESSAGE, when it is not this page's.
 * Nothing is written by it. With no page company recorded it asks nothing.
 */
export async function confirmPageCompany(client: CompanyRpc | null): Promise<void> {
  if (pageCompany === null) return;
  if (!client) throw new Error("Supabase is not configured.");
  const { data, error } = await client.rpc("current_user_organization_id");
  if (error) throw error;
  assertPageCompany(typeof data === "string" ? data : null);
}
