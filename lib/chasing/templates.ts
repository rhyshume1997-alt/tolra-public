// THE CHASE WORDING (migration 138). The DEFAULT wording for every tone is ChatGPT's renderChase (lib/chase/steps.ts, branch
// chatgpt/chase-steps). A company that has saved its own text for a tone's template (Settings > Email templates, public.email_templates)
// keeps using it; the job / parts facts reach that text as merge fields (chaseJobVars).
//   lib/email/templates/defaults.ts (DEFAULT_TEMPLATES takes CHASE_DEFAULT_TEMPLATES for the three keys: what Settings > Email templates
//   shows and saves from; 138 allows the keys in email_templates), lib/email/chase/run.ts (CHASE_TONE_TEMPLATE, chaseJobVars, defaultChaseMail).
import { type ChaseFields, renderChase } from "@/lib/chase/steps";
import type { ChaseTone } from "@/lib/chasing/steps";
import type { ChaseJobFacts } from "@/lib/email/chase/context";
import type { TemplateDefinition, TemplateKey, TemplateText, TemplateVars } from "@/lib/email/templates/defaults";

/** The three template keys 138 adds (the friendly tone uses 106's invoice_reminder). */
export const CHASE_TEMPLATE_KEYS = ["chase_before_due", "chase_firm", "chase_final"] as const;
export type ChaseTemplateKey = (typeof CHASE_TEMPLATE_KEYS)[number];

/** Which saved template (a company's own text) each tone uses. */
export const CHASE_TONE_TEMPLATE: Record<ChaseTone, TemplateKey> = {
  before_due: "chase_before_due",
  friendly: "invoice_reminder",
  firm: "chase_firm",
  final: "chase_final",
};

/** The job / parts merge fields (each "" when there is nothing to say: no job, or no supplier orders). */
export const CHASE_JOB_PLACEHOLDERS = ["job_number", "job_status", "parts_status", "parts_expected", "job_note"] as const;
const REMINDER_PLACEHOLDERS = ["greeting", "document_number", "total", "balance", "due_date", "days_overdue", "payment_note", "company_name", "customer_name", "person_name"] as const;

/** The default wording as the editor shows it: renderChase's text with the invoice's values swapped back for merge fields. */
function editorDefault(tone: ChaseTone): TemplateText {
  const BALANCE = 987654321; // "£9,876,543.21": a value no real text contains, swapped for {{balance}}
  const DAYS = 7777;
  const { subject, body } = renderChase(tone, {
    customerName: "{{customer_name}}", invoiceRef: "{{document_number}}", balancePence: BALANCE, dueDate: "{{due_date}}", daysOverdue: DAYS, companyName: "{{company_name}}",
  });
  const swap = (text: string) => text.replaceAll("£9,876,543.21", "{{balance}}").replaceAll(`${DAYS} days`, "{{days_overdue}}");
  return { subject: swap(subject), body: swap(body) };
}

/** The three templates 138 adds, as Settings shows them: renderChase's wording (the job lines are added to it when a job is known). */
export const CHASE_DEFAULT_TEMPLATES: Record<ChaseTemplateKey, TemplateDefinition> = {
  chase_before_due: {
    label: "Chase: before the due date",
    usedFor: "A chase step on or before the invoice's due date (Settings > Email schedules > Chase steps). Drafted for Approvals.",
    placeholders: [...REMINDER_PLACEHOLDERS, ...CHASE_JOB_PLACEHOLDERS],
    ...editorDefault("before_due"),
  },
  chase_firm: {
    label: "Chase: firm",
    usedFor: "A firm chase step after the due date (Settings > Email schedules > Chase steps). Drafted for Approvals.",
    placeholders: [...REMINDER_PLACEHOLDERS, ...CHASE_JOB_PLACEHOLDERS],
    ...editorDefault("firm"),
  },
  chase_final: {
    label: "Chase: final",
    usedFor: "The final chase step (Settings > Email schedules > Chase steps). Drafted for Approvals.",
    placeholders: [...REMINDER_PLACEHOLDERS, ...CHASE_JOB_PLACEHOLDERS],
    ...editorDefault("final"),
  },
};

/** The default e-mail for a tone: ChatGPT's renderChase, with the job / parts facts when the invoice has a job. */
export function defaultChaseMail(tone: ChaseTone, fields: Omit<ChaseFields, "jobRef" | "jobStatus" | "partsWaiting" | "supplierExpectedDate">, facts: ChaseJobFacts | null): { subject: string; text: string } {
  const { subject, body } = renderChase(tone, {
    ...fields,
    ...(facts ? {
      jobRef: facts.jobNumber || undefined,
      jobStatus: facts.jobState || undefined,
      partsWaiting: facts.partsAwaited ? ["on order with the supplier"] : undefined,
      supplierExpectedDate: facts.partsAwaited ? facts.partsExpected ?? undefined : undefined,
    } : {}),
  });
  return { subject, text: body };
}

/**
 * The job / parts facts as merge-field values for a company's own text. No job: every value "". The plain facts only (the job number, its
 * state, the expected date as given); parts_status and job_note stay "" (the default wording carries the parts line itself).
 */
export function chaseJobVars(facts: ChaseJobFacts | null): Record<(typeof CHASE_JOB_PLACEHOLDERS)[number], string> {
  return {
    job_number: facts?.jobNumber ?? "",
    job_status: facts?.jobState ?? "",
    parts_status: "",
    parts_expected: facts?.partsExpected ?? "",
    job_note: "",
  };
}

export type { TemplateVars };
