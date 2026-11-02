// THE CHASE WORDING INTERFACE (migration 138). ChatGPT writes the chase wording here (branch chatgpt/chase-steps, Rhys, 2 Nov); this
// file is a minimal STUB so the joining-up can be built and tested.
//
// TODO-CHATGPT: the default texts for the before-due, firm and final tones, which template each tone uses, and how the job / parts facts
// read in an e-mail (chaseJobVars). Keep the names and types below, or change the callers with them:
//   lib/email/templates/defaults.ts (DEFAULT_TEMPLATES takes CHASE_DEFAULT_TEMPLATES for the three keys; Settings > Email templates
//   shows and saves them; 138 allows the keys in email_templates), lib/email/chase/run.ts (CHASE_TONE_TEMPLATE, chaseJobVars).
import type { ChaseTone } from "@/lib/chasing/steps";
import type { ChaseJobFacts } from "@/lib/email/chase/context";
import type { TemplateDefinition, TemplateKey, TemplateVars } from "@/lib/email/templates/defaults";

/** The three template keys 138 adds (the friendly tone uses 106's invoice_reminder). */
export const CHASE_TEMPLATE_KEYS = ["chase_before_due", "chase_firm", "chase_final"] as const;
export type ChaseTemplateKey = (typeof CHASE_TEMPLATE_KEYS)[number];

/** TODO-CHATGPT. STUB: which template each tone drafts with. */
export const CHASE_TONE_TEMPLATE: Record<ChaseTone, TemplateKey> = {
  before_due: "chase_before_due",
  friendly: "invoice_reminder",
  firm: "chase_firm",
  final: "chase_final",
};

/** The job / parts merge fields (each "" when there is nothing to say: no job, or no supplier orders). */
export const CHASE_JOB_PLACEHOLDERS = ["job_number", "job_status", "parts_status", "parts_expected", "job_note"] as const;
const REMINDER_PLACEHOLDERS = ["greeting", "document_number", "total", "balance", "due_date", "days_overdue", "payment_note", "company_name", "customer_name", "person_name"] as const;

/**
 * TODO-CHATGPT. STUB texts. Firm and final are the texts kept on main in defaults.ts's comment (Astra's wording, Rhys 30 Oct), verbatim;
 * before-due is a placeholder until the agreed wording lands.
 */
export const CHASE_DEFAULT_TEMPLATES: Record<ChaseTemplateKey, TemplateDefinition> = {
  chase_before_due: {
    label: "Chase: before the due date",
    usedFor: "A chase step on or before the invoice's due date (Settings > Email schedules > Chase steps). Drafted for Approvals.",
    placeholders: [...REMINDER_PLACEHOLDERS, ...CHASE_JOB_PLACEHOLDERS],
    subject: "Invoice {{document_number}} from {{company_name}}",
    body: "Hi {{customer_name}}\n\nInvoice {{document_number}} for {{balance}} is due on {{due_date}}\n\nThanks,\n{{company_name}}",
  },
  chase_firm: {
    label: "Chase: firm",
    usedFor: "A firm chase step after the due date (Settings > Email schedules > Chase steps). Drafted for Approvals.",
    placeholders: [...REMINDER_PLACEHOLDERS, ...CHASE_JOB_PLACEHOLDERS],
    subject: "Overdue invoice {{document_number}} from {{company_name}}",
    body: "Hi {{customer_name}}\n\nInvoice {{document_number}} remains unpaid, with {{balance}} outstanding since {{due_date}}\n\nPlease arrange payment and reply to confirm the payment date\n\nIf there's a query holding this up, please let us know today so we can resolve it\n\nThanks,\n{{company_name}}",
  },
  chase_final: {
    label: "Chase: final",
    usedFor: "The final chase step (Settings > Email schedules > Chase steps). Drafted for Approvals.",
    placeholders: [...REMINDER_PLACEHOLDERS, ...CHASE_JOB_PLACEHOLDERS],
    subject: "Overdue invoice {{document_number}} from {{company_name}}",
    body: "Hi {{customer_name}}\n\nThis is our final email reminder for invoice {{document_number}}, with {{balance}} outstanding since {{due_date}}\n\nPlease arrange payment now or contact us today to discuss the outstanding balance\n\nIf we don't hear from you, we'll contact you directly to agree the next steps\n\nThanks,\n{{company_name}}",
  },
};

/**
 * TODO-CHATGPT. STUB: the job / parts facts as merge-field values. No job: every value "". The stub gives the plain facts only (the job
 * number, its state, the expected date as given) and leaves parts_status and job_note "" (no sentence is written yet).
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
