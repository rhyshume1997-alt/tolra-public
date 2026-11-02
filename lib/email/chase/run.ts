// One chase pass for one company (migration 138): for each invoice that is owed, the steps due today (lib/chasing/steps.ts dueChaseSteps,
// TODO-CHATGPT), each rendered in its tone (the company's own wording or the default) and saved as a DRAFT for the Approvals queue through
// public.chase_create_draft, which re-checks everything in the database and keeps each step to once per invoice. NOTHING IS SENT HERE:
// an office or admin user approves each draft (app/api/chase/approve). Used by the scheduled pass (108's invoice_reminder schedule,
// lib/email/schedules/reminders.ts) and by Invoices > Chase All Overdue (app/api/chase/run). Counts only come out: never an address or
// a document text.
import type { SupabaseClient } from "@supabase/supabase-js";

import { type ChaseStep, dueChaseSteps } from "@/lib/chasing/steps";
import { CHASE_TONE_TEMPLATE, chaseJobVars } from "@/lib/chasing/templates";
import { type ChaseJob, type ChaseOrder, chaseJobFacts } from "@/lib/email/chase/context";
import { isChaseTone, pauseActive } from "@/lib/email/chase/steps";
import { StoreError, isMissingTable, loadCompanyName, readAll } from "@/lib/email/schedules/store";
import { type TemplateKey, type TemplateText, invoiceReminderVars, renderTemplate } from "@/lib/email/templates/defaults";
import { fmtDate } from "@/lib/dates";
import { fromPence, gbp, toPence } from "@/lib/money";
import { balanceDue, daysPastDue, invoiceLifecycle } from "@/lib/receivables";

export const CHASE_NOT_APPLIED = "database update 138 not applied";

export type ChaseInvoiceRow = {
  id: string;
  invoice_ref: string | null;
  customer: string;
  job_id: string | null;
  total: number | string | null;
  amount_paid: number | string | null;
  credited_amount: number | string | null;
  refunded_amount: number | string | null;
  status: string | null;
  due_date: string | null;
  payment_unverified: boolean | null;
  /** 138: the customer says they've paid (mark_payment_claimed): never chased while set. */
  payment_claimed_at?: string | null;
};
export type ChaseCandidate = ChaseInvoiceRow & { balance: number; daysFromDue: number };

/** What a pass reports. `sent` is always 0: a chase pass only drafts. `reasons`: why invoices were skipped, counted by reason. */
export type ChaseResult = { sent: number; drafted: number; skipped: number; failed: number; error: string | null; retryable: boolean; reasons: Record<string, number> };

export type DraftArgs = { organizationId: string; invoiceId: string; stepId: string; to: string; toName: string | null; subject: string; body: string; userId: string | null };
export type DraftAnswer = { created: true; history_id: string } | { created: false; reason: string };

export type ChaseDeps = {
  /** public.chase_create_draft through the service role (the default), or a stand-in in tests. */
  createDraft?: (admin: SupabaseClient, args: DraftArgs) => Promise<DraftAnswer>;
  deadline?: number;
  clock?: () => number;
};

const INVOICE_COLUMNS = "id, invoice_ref, customer, job_id, total, amount_paid, credited_amount, refunded_amount, status, due_date, payment_unverified, payment_claimed_at";
/** Statuses the database query leaves out (lib/receivables NOT_COLLECTIBLE plus paid); the pure filter below decides again, as the database does. */
const EXCLUDED_STATUSES = "(draft,void,voided,cancelled,canceled,credited,written_off,paid)";
const looksLikeEmail = (value: string) => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(value) && value.length <= 254;
const key = (name: string) => name.trim().toLowerCase();

/** Invoices that are owed and have reached at least the earliest step on `today` (YYYY-MM-DD), oldest due first. */
export function chaseCandidates(rows: readonly ChaseInvoiceRow[], today: string, earliestOffset: number): ChaseCandidate[] {
  const out: ChaseCandidate[] = [];
  for (const row of rows) {
    if (!row.invoice_ref?.trim()) continue;
    if (invoiceLifecycle(row.status) !== "collectible") continue;
    if (row.payment_unverified) continue;
    if (row.payment_claimed_at) continue;
    const days = daysPastDue(row.due_date, today);
    if (days === null || days < earliestOffset) continue;
    const balance = balanceDue(Number(row.total) || 0, Number(row.amount_paid) || 0, Number(row.credited_amount) || 0, Number(row.refunded_amount) || 0);
    if (balance <= 0) continue;
    out.push({ ...row, balance, daysFromDue: days });
  }
  return out.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? "") || a.id.localeCompare(b.id));
}

export { pauseActive };

async function rpcCreateDraft(admin: SupabaseClient, args: DraftArgs): Promise<DraftAnswer> {
  const { data, error } = await admin.rpc("chase_create_draft", {
    p_org: args.organizationId, p_invoice: args.invoiceId, p_step: args.stepId, p_to: args.to, p_to_name: args.toName, p_subject: args.subject, p_body: args.body, p_user: args.userId,
  });
  if (error) throw new StoreError("create chase draft", error.code);
  const answer = data as { created?: boolean; history_id?: string; reason?: string } | null;
  return answer?.created && answer.history_id ? { created: true, history_id: answer.history_id } : { created: false, reason: answer?.reason ?? "unknown" };
}

/** The company's own text for each chase template (106's email_templates), keyed by template. Missing or unreadable: the default is used. */
async function loadOverrides(admin: SupabaseClient, organizationId: string): Promise<Partial<Record<TemplateKey, TemplateText>>> {
  const out: Partial<Record<TemplateKey, TemplateText>> = {};
  try {
    const { data, error } = await admin.from("email_templates").select("key, subject, body").eq("organization_id", organizationId).in("key", [...new Set(Object.values(CHASE_TONE_TEMPLATE))]);
    if (error || !data) return out;
    for (const row of data as Array<{ key: TemplateKey; subject: string; body: string }>) if (row.subject?.trim() && row.body?.trim()) out[row.key] = { subject: row.subject, body: row.body };
  } catch {
    // the defaults
  }
  return out;
}

/** The invoices' jobs and the supplier orders bought for them (by job, or by the job's quote). A read that fails leaves the wording out. */
async function loadJobContext(admin: SupabaseClient, organizationId: string, jobIds: string[]) {
  const jobs = new Map<string, ChaseJob & { quote_id: string | null }>();
  const orders = new Map<string, ChaseOrder[]>();
  if (!jobIds.length) return { jobs, orders };
  try {
    const { data: jobRows, error } = await admin.from("jobs").select("id, job_no, stage, status, finished_at, quote_id").eq("organization_id", organizationId).in("id", jobIds);
    if (error) return { jobs, orders };
    for (const j of (jobRows ?? []) as Array<ChaseJob & { id: string; quote_id: string | null }>) jobs.set(j.id, j);
    const quoteIds = [...jobs.values()].map((j) => j.quote_id).filter((q): q is string => !!q);
    const [byJob, byQuote] = await Promise.all([
      admin.from("purchase_orders").select("id, job_id, quote_id, status, received_at, expected_delivery").eq("organization_id", organizationId).in("job_id", [...jobs.keys()]),
      quoteIds.length ? admin.from("purchase_orders").select("id, job_id, quote_id, status, received_at, expected_delivery").eq("organization_id", organizationId).in("quote_id", quoteIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (byJob.error || byQuote.error) return { jobs, orders: new Map<string, ChaseOrder[]>() };
    type PoRow = ChaseOrder & { id: string; job_id: string | null; quote_id: string | null };
    const all = [...((byJob.data ?? []) as PoRow[]), ...((byQuote.data ?? []) as PoRow[])];
    for (const [jobId, job] of jobs) {
      const list: ChaseOrder[] = [];
      const ids = new Set<string>();
      for (const po of all) {
        if ((po.job_id === jobId || (job.quote_id && po.quote_id === job.quote_id)) && !ids.has(po.id)) {
          ids.add(po.id); // an order linked to both the job and its quote counts once
          list.push(po);
        }
      }
      orders.set(jobId, list);
    }
  } catch {
    return { jobs: new Map(), orders: new Map() };
  }
  return { jobs, orders };
}

/**
 * Drafts today's chase e-mails for one company. `recipients`: the schedule's fixed addresses (108), else each invoice's customer's address
 * on file (customers without one are skipped). `userId`: the person who asked (Chase All Overdue), or null for the scheduled pass.
 */
export async function runChase(
  admin: SupabaseClient,
  input: { organizationId: string; today: string; recipients?: string[] | null; userId?: string | null },
  deps: ChaseDeps = {},
): Promise<ChaseResult> {
  const result: ChaseResult = { sent: 0, drafted: 0, skipped: 0, failed: 0, error: null, retryable: true, reasons: {} };
  const skip = (reason: string) => { result.skipped += 1; result.reasons[reason] = (result.reasons[reason] ?? 0) + 1; };
  const org = input.organizationId;
  const createDraft = deps.createDraft ?? rpcCreateDraft;

  const stepRead = await admin.from("chase_steps").select("id, offset_days, tone").eq("organization_id", org).order("offset_days");
  if (isMissingTable(stepRead.error)) return { ...result, error: CHASE_NOT_APPLIED, retryable: false };
  if (stepRead.error) throw new StoreError("read chase steps", stepRead.error.code);
  const steps = ((stepRead.data ?? []) as ChaseStep[]).filter((s) => Number.isInteger(s.offset_days) && isChaseTone(s.tone));
  if (!steps.length) return result; // no steps: nothing to chase
  const earliest = Math.min(...steps.map((s) => s.offset_days));

  const rows = await readAll<ChaseInvoiceRow>((from, to) => admin.from("invoices").select(INVOICE_COLUMNS).eq("organization_id", org)
    .not("due_date", "is", null).not("invoice_ref", "is", null).not("status", "in", EXCLUDED_STATUSES).order("due_date").order("id").range(from, to));
  const candidates = chaseCandidates(rows, input.today, earliest);
  if (!candidates.length) return result;

  const [pauses, sends, customersList, companyName, overrides] = await Promise.all([
    readAll<{ invoice_id: string | null; customer_id: string | null; paused_until: string | null }>((from, to) => admin.from("chase_pauses").select("invoice_id, customer_id, paused_until").eq("organization_id", org).order("id").range(from, to)),
    readAll<{ invoice_id: string; step_id: string | null; offset_days: number }>((from, to) => admin.from("chase_sends").select("invoice_id, step_id, offset_days").eq("organization_id", org).order("id").range(from, to)),
    readAll<{ id: string; name: string; email: string | null; contact_name: string | null }>((from, to) => admin.from("customers").select("id, name, email, contact_name").eq("organization_id", org).order("id").range(from, to)),
    loadCompanyName(admin, org),
    loadOverrides(admin, org),
  ]);
  const pausedInvoices = new Set(pauses.filter((p) => p.invoice_id && pauseActive(p.paused_until, input.today)).map((p) => p.invoice_id as string));
  const pausedCustomerIds = new Set(pauses.filter((p) => p.customer_id && pauseActive(p.paused_until, input.today)).map((p) => p.customer_id as string));
  const customers = new Map<string, { name: string; email: string | null; contact_name: string | null }>();
  const pausedNames = new Set<string>();
  for (const c of customersList) {
    if (pausedCustomerIds.has(c.id)) pausedNames.add(key(c.name));
    const email = c.email?.trim() ?? "";
    if (email && looksLikeEmail(email) && !customers.has(key(c.name))) customers.set(key(c.name), c);
  }
  const history = new Map<string, { stepIds: string[]; offsets: number[] }>();
  for (const s of sends) {
    const h = history.get(s.invoice_id) ?? { stepIds: [], offsets: [] };
    if (s.step_id) h.stepIds.push(s.step_id);
    h.offsets.push(Number(s.offset_days));
    history.set(s.invoice_id, h);
  }
  const fixed = (input.recipients ?? []).map((r) => r.trim()).filter(looksLikeEmail);

  // What each invoice gets today, before any job lookup.
  const planned: Array<{ invoice: ChaseCandidate; step: ChaseStep }> = [];
  for (const invoice of candidates) {
    if (pausedInvoices.has(invoice.id)) { skip("invoice_paused"); continue; }
    if (pausedNames.has(key(invoice.customer))) { skip("customer_paused"); continue; }
    const due = dueChaseSteps(steps, invoice.daysFromDue, history.get(invoice.id));
    if (!due.length) { skip("no_step_due"); continue; }
    for (const step of due) planned.push({ invoice, step });
  }
  const context = await loadJobContext(admin, org, [...new Set(planned.map((p) => p.invoice.job_id).filter((j): j is string => !!j))]);

  const clock = deps.clock ?? Date.now;
  const failures = new Set<string>();
  let stoppedEarly = false;
  for (const { invoice, step } of planned) {
    if (deps.deadline !== undefined && clock() > deps.deadline) { stoppedEarly = true; break; }
    const customer = customers.get(key(invoice.customer));
    const to = fixed.length ? fixed : customer?.email ? [customer.email.trim()] : [];
    if (!to.length) { skip("no_address"); continue; }
    const job = invoice.job_id ? context.jobs.get(invoice.job_id) ?? null : null;
    const jobVars = chaseJobVars(job ? chaseJobFacts(job, context.orders.get(invoice.job_id as string) ?? []) : null);
    const received = Number(invoice.amount_paid) || 0;
    const template = CHASE_TONE_TEMPLATE[step.tone];
    const mail = renderTemplate(template, invoiceReminderVars({
      reference: invoice.invoice_ref ?? "",
      total: gbp(fromPence(toPence(invoice.balance) + toPence(received)), 2),
      dueDate: fmtDate(invoice.due_date),
      daysOverdue: Math.max(0, invoice.daysFromDue),
      companyName,
      customerName: invoice.customer,
      contactName: customer?.contact_name,
      amountPaid: received,
      paidText: gbp(received, 2),
      balanceText: gbp(invoice.balance, 2),
      job: jobVars,
    }), overrides[template]);
    try {
      const answer = await createDraft(admin, {
        organizationId: org, invoiceId: invoice.id, stepId: step.id, to: to.join(", "), toName: fixed.length ? null : (customer?.contact_name?.trim() || customer?.name || null),
        subject: mail.subject, body: mail.text, userId: input.userId ?? null,
      });
      if (answer.created) result.drafted += 1;
      else skip(answer.reason);
    } catch (err) {
      result.failed += 1;
      failures.add(err instanceof StoreError && err.code ? err.code : "unexpected");
    }
  }
  const problems = [
    result.failed ? `${result.failed} chase draft${result.failed === 1 ? "" : "s"} not made (${[...failures].sort().join(", ")})` : "",
    stoppedEarly ? "stopped at the time limit; the rest goes on the next try" : "",
  ].filter(Boolean);
  result.error = problems.length ? problems.join("; ") : null;
  return result;
}
