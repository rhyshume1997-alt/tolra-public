import "server-only";
import { z } from "zod";

/**
 * BOUNDARY: lib/portal/types.ts (module 10, customer portal). Server-only.
 * INPUTS: raw JSON answers of the release 154 functions (portal_signin_request / _verify, portal_session_resolve / _end,
 * portal_quotes, portal_jobs). OUTPUTS: the strict zod schemas that parse them, and the camelCase types the rest of the module uses.
 * MUST NOT CHANGE without telling the app/api/portal, app/portal and lib/portal/staff.ts builders: the exported names below are the
 * contract (all other builders import only these):
 *   PortalRefusal {ok:false, reason:'refused', correlationId}   PortalResult<T> = {ok:true,data:T} | PortalRefusal
 *   PortalPermission, PortalSession, PortalQuote, PortalJob, PortalJobStage, PortalSignin (what verify returns: session + cookie token)
 *   PORTAL_CODE_PATH (the e-mailed link is `${origin}${PORTAL_CODE_PATH}/${ref}`; the page at app/portal/code/[ref] must match)
 *   rpc*Schema (raw, snake_case, strict: an unexpected field fails the parse, which is treated as a refusal)
 * NEVER in these types: `sends`, e-mail, ids of the company or customer, hashes, codes or tokens (except PortalSignin.token, which only
 * the verify route may read, to set the cookie).
 */

export const PORTAL_CODE_PATH = "/portal/code";

export const portalPermissionSchema = z.enum(["quotes", "jobs"]);
export type PortalPermission = z.infer<typeof portalPermissionSchema>;

/** The one answer for every refusal (off, malformed, wrong, expired, limited, unreachable). Says nothing about why. */
export type PortalRefusal = { ok: false; reason: "refused"; correlationId: string };
export type PortalResult<T> = { ok: true; data: T } | PortalRefusal;

const refusalRaw = z.object({ ok: z.literal(false), reason: z.literal("refused"), correlation_id: z.string().min(1).max(64) }).strict();

const sessionRaw = z.object({
  contact_id: z.string().min(1),
  display_name: z.string(),
  company_name: z.string(),
  customer_name: z.string(),
  permissions: z.array(portalPermissionSchema).min(1).max(2),
  idle_expires_at: z.string().min(1),
  absolute_expires_at: z.string().min(1),
}).strict();

export type PortalSession = {
  contactId: string;
  displayName: string;
  companyName: string;
  customerName: string;
  permissions: PortalPermission[];
  idleExpiresAt: string;
  absoluteExpiresAt: string;
};
export const toPortalSession = (raw: z.infer<typeof sessionRaw>): PortalSession => ({
  contactId: raw.contact_id, displayName: raw.display_name, companyName: raw.company_name, customerName: raw.customer_name,
  permissions: raw.permissions, idleExpiresAt: raw.idle_expires_at, absoluteExpiresAt: raw.absolute_expires_at,
});

/** verify's answer: the session plus the cookie token the server made (only the route that sets the cookie reads `token`). */
export type PortalSignin = { session: PortalSession; token: string };

const numeric = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);
const quoteRaw = z.object({
  quote_ref: z.string(),
  status: z.enum(["sent", "accepted", "rejected"]),
  sent_at: z.string().nullable(),
  valid_until: z.string().nullable(),
  customer_po: z.string().nullable(),
  total_value: numeric.nullable(),
}).strict();
export type PortalQuote = { quoteRef: string; status: "sent" | "accepted" | "rejected"; sentAt: string | null; validUntil: string | null; customerPo: string | null; totalValue: number | null };
export const toPortalQuote = (raw: z.infer<typeof quoteRaw>): PortalQuote => ({
  quoteRef: raw.quote_ref, status: raw.status, sentAt: raw.sent_at, validUntil: raw.valid_until, customerPo: raw.customer_po, totalValue: raw.total_value,
});

export const portalJobStageSchema = z.enum(["not_started", "in_progress", "complete"]);
export type PortalJobStage = z.infer<typeof portalJobStageSchema>;
const jobRaw = z.object({ job_no: z.string(), customer_po: z.string().nullable(), due_date: z.string().nullable(), stage: portalJobStageSchema }).strict();
export type PortalJob = { jobNo: string; customerPo: string | null; dueDate: string | null; stage: PortalJobStage };
export const toPortalJob = (raw: z.infer<typeof jobRaw>): PortalJob => ({ jobNo: raw.job_no, customerPo: raw.customer_po, dueDate: raw.due_date, stage: raw.stage });

/** Raw RPC answers: success or the refusal. `sends` (request) is internal to the module and never returned from it. */
export const rpcRequestSchema = z.union([
  z.object({ ok: z.literal(true), email: z.string(), sends: z.array(z.object({ slot: z.number().int().min(1).max(10), company_name: z.string(), customer_name: z.string() }).strict()).max(10) }).strict(),
  refusalRaw,
]);
export const rpcSessionSchema = z.union([z.object({ ok: z.literal(true), session: sessionRaw }).strict(), refusalRaw]);
export const rpcEndSchema = z.union([z.object({ ok: z.literal(true) }).strict(), refusalRaw]);
export const rpcQuotesSchema = z.union([z.object({ ok: z.literal(true), quotes: z.array(quoteRaw) }).strict(), refusalRaw]);
export const rpcJobsSchema = z.union([z.object({ ok: z.literal(true), jobs: z.array(jobRaw) }).strict(), refusalRaw]);
