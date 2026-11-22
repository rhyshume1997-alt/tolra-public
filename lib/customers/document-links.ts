/**
 * Customers module: which customer record a job or quote belongs to (release 153 v2, supabase/release/153_document_customer_link.release.sql).
 * Path: lib/customers/document-links.ts (PR-B; merge only after PR-A1 + PR-A2 release 153 is applied).
 *
 * Inputs: the signed-in Supabase client of the person using the app (their own session: never the service role, never a company id).
 * Outputs: the VERIFIED links of jobs and quotes (public.document_customer_links_verified: live, verified by a person, neither the
 * document's customer text nor the customer's name changed since; never an internal job), the backfill links still waiting for a
 * person to verify them, and the calls a later admin / office screen makes: link, link with a different name (admin), verify, unlink,
 * retire (admin), the customer-portal switch's status and setting it (admin).
 * Must not change: the database decides every rule (role, never a support or read-only session, a fresh authenticator code for every
 * link action and for switching ON, a reason, same company, name rules). This file only shapes calls and answers; it never reads costs,
 * margins, balances, totals, statuses or quote approval, and links only jobs and quotes.
 */

export type DocumentKind = "job" | "quote";
export const DOCUMENT_KINDS: readonly DocumentKind[] = ["job", "quote"];
export type RetireTargetKind = DocumentKind | "customer";
export type LinkSource = "backfill" | "manual" | "name_override";

/** One row of public.document_customer_links_verified (exactly its seven columns). */
export type VerifiedDocumentCustomerLink = {
  id: string;
  organizationId: string;
  docKind: DocumentKind;
  documentId: string;
  customerId: string;
  source: LinkSource;
  verifiedAt: string;
};
/** A backfill link waiting for a person to verify it (read from the table under admin / office row security). */
export type PendingBackfillLink = {
  id: string;
  docKind: DocumentKind;
  documentId: string;
  customerId: string;
  documentCustomerText: string;
  customerNameAtLink: string;
  linkedAt: string;
};
export type LinkResult = { linkId: string; docKind: DocumentKind; documentId: string; customerId: string; source: LinkSource };
export type VerifyResult = { verified: number; verifiedAt: string };
export type UnlinkResult = { linkId: string; unlinkedAt: string };
export type RetireResult = { retired: number; targetKind: RetireTargetKind; targetId: string };
export type PortalSwitchStatus = { enabled: boolean; changedAt: string | null };

/** The database's refusal hints (153 v2), plus "unknown" for anything else. */
export type DocumentLinkErrorCode =
  | "admin_required" | "admin_or_office_required" | "mfa_required" | "mfa_recent_required" | "reason_required" | "invalid_kind"
  | "document_not_found" | "customer_not_found" | "internal_job" | "customer_mismatch" | "identity_not_confirmed" | "names_match"
  | "no_customer_text" | "already_linked" | "not_linked" | "invalid_batch" | "not_pending" | "link_not_found" | "link_stale"
  | "link_immutable" | "link_other_company" | "invalid_enabled" | "unknown";
const KNOWN_HINTS: readonly DocumentLinkErrorCode[] = [
  "admin_required", "admin_or_office_required", "mfa_required", "mfa_recent_required", "reason_required", "invalid_kind",
  "document_not_found", "customer_not_found", "internal_job", "customer_mismatch", "identity_not_confirmed", "names_match",
  "no_customer_text", "already_linked", "not_linked", "invalid_batch", "not_pending", "link_not_found", "link_stale", "link_immutable",
  "link_other_company", "invalid_enabled",
];

export class DocumentLinkError extends Error {
  readonly code: DocumentLinkErrorCode;
  constructor(code: DocumentLinkErrorCode, message: string) {
    super(message);
    this.name = "DocumentLinkError";
    this.code = code;
  }
}

export type DbError = { message: string; code?: string; hint?: string };
export type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: DbError | null }> };
type Rows = PromiseLike<{ data: unknown[] | null; error: DbError | null }>;
/** The verified view, by kind and document ids. */
export type VerifiedLinksClient = {
  from: (relation: "document_customer_links_verified") => {
    select: (columns: string) => { eq: (column: "doc_kind", value: DocumentKind) => { in: (column: "document_id", values: readonly string[]) => Rows } };
  };
};
/** The table, for links waiting to be verified (row security: admin and office of the company, sections they can see). */
export type PendingLinksClient = {
  from: (relation: "document_customer_links") => {
    select: (columns: string) => {
      eq: (column: "source", value: "backfill") => {
        is: (column: "verified_at", value: null) => {
          is: (column: "unlinked_at", value: null) => { order: (column: "linked_at", opts: { ascending: boolean }) => { limit: (n: number) => Rows } };
        };
      };
    };
  };
};

export const VERIFIED_LINK_COLUMNS = "id, organization_id, doc_kind, document_id, customer_id, source, verified_at";
export const PENDING_LINK_COLUMNS = "id, doc_kind, job_id, quote_id, customer_id, document_customer_text, customer_name_at_link, linked_at";
/** Same limit as the database (1..500 characters after trimming). */
export const REASON_MAX = 500;
/** Ids per read, to keep the request URL short. */
export const READ_CHUNK = 200;
/** Same limit as verify_document_customer_links (1..200 links per call). */
export const VERIFY_BATCH_MAX = 200;
export const PENDING_PAGE = 200;

export function isDocumentKind(value: unknown): value is DocumentKind {
  return value === "job" || value === "quote";
}

/** The trimmed reason, or a reason_required refusal before any call. */
export function checkReason(reason: string): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length < 1 || trimmed.length > REASON_MAX) throw new DocumentLinkError("reason_required", `Give a reason (up to ${REASON_MAX} characters).`);
  return trimmed;
}

export function linkErrorFrom(error: DbError): DocumentLinkError {
  const code = KNOWN_HINTS.find(h => h === error.hint) ?? "unknown";
  return new DocumentLinkError(code, error.message);
}

function assertKind(kind: unknown): asserts kind is DocumentKind {
  if (!isDocumentKind(kind)) throw new DocumentLinkError("invalid_kind", "Only jobs and quotes can be linked to a customer.");
}

function toLink(row: Record<string, unknown>): VerifiedDocumentCustomerLink {
  return {
    id: String(row.id), organizationId: String(row.organization_id), docKind: row.doc_kind as DocumentKind, documentId: String(row.document_id),
    customerId: String(row.customer_id), source: row.source as LinkSource, verifiedAt: String(row.verified_at),
  };
}

function toLinkResult(data: unknown): LinkResult {
  const r = data as Record<string, unknown>;
  return { linkId: String(r.link_id), docKind: r.doc_kind as DocumentKind, documentId: String(r.document_id), customerId: String(r.customer_id), source: r.source as LinkSource };
}

/** Verified links for these documents of one kind, keyed by document id. Unverified, unlinked and stale ones are simply absent. */
export async function readVerifiedLinks(client: VerifiedLinksClient, kind: DocumentKind, documentIds: readonly string[]): Promise<Map<string, VerifiedDocumentCustomerLink>> {
  assertKind(kind);
  const out = new Map<string, VerifiedDocumentCustomerLink>();
  const ids = [...new Set(documentIds)];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await client.from("document_customer_links_verified").select(VERIFIED_LINK_COLUMNS).eq("doc_kind", kind).in("document_id", ids.slice(i, i + READ_CHUNK));
    if (error) throw linkErrorFrom(error);
    for (const row of data ?? []) {
      const link = toLink(row as Record<string, unknown>);
      out.set(link.documentId, link);
    }
  }
  return out;
}

/** The oldest backfill links still waiting for a person (at most PENDING_PAGE). Never shown to a customer. */
export async function readPendingBackfillLinks(client: PendingLinksClient): Promise<PendingBackfillLink[]> {
  const { data, error } = await client.from("document_customer_links").select(PENDING_LINK_COLUMNS)
    .eq("source", "backfill").is("verified_at", null).is("unlinked_at", null).order("linked_at", { ascending: true }).limit(PENDING_PAGE);
  if (error) throw linkErrorFrom(error);
  return (data ?? []).map(raw => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id), docKind: r.doc_kind as DocumentKind, documentId: String(r.job_id ?? r.quote_id), customerId: String(r.customer_id),
      documentCustomerText: String(r.document_customer_text), customerNameAtLink: String(r.customer_name_at_link), linkedAt: String(r.linked_at),
    };
  });
}

/** Admin or office; names must match; the database asks for a fresh authenticator code. */
export async function linkDocumentCustomer(client: RpcClient, input: { kind: DocumentKind; documentId: string; customerId: string; reason: string }): Promise<LinkResult> {
  assertKind(input.kind);
  const reason = checkReason(input.reason);
  const { data, error } = await client.rpc("link_document_customer", { p_kind: input.kind, p_document: input.documentId, p_customer: input.customerId, p_reason: reason });
  if (error) throw linkErrorFrom(error);
  return toLinkResult(data);
}

/** Admin only; the names differ; the admin must have confirmed who the customer is (refused before any call otherwise). */
export async function linkDocumentCustomerNameOverride(
  client: RpcClient, input: { kind: DocumentKind; documentId: string; customerId: string; reason: string; identityConfirmed: boolean },
): Promise<LinkResult> {
  assertKind(input.kind);
  const reason = checkReason(input.reason);
  if (input.identityConfirmed !== true) throw new DocumentLinkError("identity_not_confirmed", "Confirm you have checked who the customer is before linking a different name.");
  const { data, error } = await client.rpc("link_document_customer_name_override", {
    p_kind: input.kind, p_document: input.documentId, p_customer: input.customerId, p_reason: reason, p_identity_confirmed: true,
  });
  if (error) throw linkErrorFrom(error);
  return toLinkResult(data);
}

/** Admin or office; 1..200 waiting backfill links; one reason; all or nothing. */
export async function verifyDocumentCustomerLinks(client: RpcClient, input: { linkIds: readonly string[]; reason: string }): Promise<VerifyResult> {
  const reason = checkReason(input.reason);
  const ids = [...new Set(input.linkIds.filter(id => typeof id === "string" && id.length > 0))];
  if (ids.length < 1 || ids.length > VERIFY_BATCH_MAX) throw new DocumentLinkError("invalid_batch", `Choose between 1 and ${VERIFY_BATCH_MAX} links to verify.`);
  const { data, error } = await client.rpc("verify_document_customer_links", { p_links: ids, p_reason: reason });
  if (error) throw linkErrorFrom(error);
  const r = data as Record<string, unknown>;
  return { verified: Number(r.verified), verifiedAt: String(r.verified_at) };
}

/** Admin or office. Also how a wrong backfill link is rejected. */
export async function unlinkDocumentCustomer(client: RpcClient, input: { kind: DocumentKind; documentId: string; reason: string }): Promise<UnlinkResult> {
  assertKind(input.kind);
  const reason = checkReason(input.reason);
  const { data, error } = await client.rpc("unlink_document_customer", { p_kind: input.kind, p_document: input.documentId, p_reason: reason });
  if (error) throw linkErrorFrom(error);
  const r = data as Record<string, unknown>;
  return { linkId: String(r.link_id), unlinkedAt: String(r.unlinked_at) };
}

/** Admin only: before a job, quote or customer with link history is deleted. Does not delete the record itself. */
export async function retireDocumentCustomerLinks(client: RpcClient, input: { targetKind: RetireTargetKind; targetId: string; reason: string }): Promise<RetireResult> {
  if (input.targetKind !== "job" && input.targetKind !== "quote" && input.targetKind !== "customer") {
    throw new DocumentLinkError("invalid_kind", "Retire the links of a job, a quote or a customer.");
  }
  const reason = checkReason(input.reason);
  const { data, error } = await client.rpc("retire_document_customer_links", { p_target_kind: input.targetKind, p_target: input.targetId, p_reason: reason });
  if (error) throw linkErrorFrom(error);
  const r = data as Record<string, unknown>;
  return { retired: Number(r.retired), targetKind: r.target_kind as RetireTargetKind, targetId: String(r.target_id) };
}

export async function customerPortalStatus(client: RpcClient): Promise<PortalSwitchStatus> {
  const { data, error } = await client.rpc("customer_portal_status", {});
  if (error) throw linkErrorFrom(error);
  const r = data as Record<string, unknown>;
  return { enabled: r.enabled === true, changedAt: typeof r.changed_at === "string" ? r.changed_at : null };
}

/** Admin. ON needs a fresh authenticator code (the database asks); OFF never waits for one. Both need a reason. */
export async function setCustomerPortalEnabled(client: RpcClient, input: { enabled: boolean; reason: string }): Promise<PortalSwitchStatus> {
  const reason = checkReason(input.reason);
  const { data, error } = await client.rpc("customer_portal_set_enabled", { p_enabled: input.enabled === true, p_reason: reason });
  if (error) throw linkErrorFrom(error);
  const r = data as Record<string, unknown>;
  return { enabled: r.enabled === true, changedAt: typeof r.changed_at === "string" ? r.changed_at : null };
}
