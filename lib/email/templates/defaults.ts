/**
 * Company e-mail templates (E11): the default texts and the one pure renderer used everywhere (the senders, the server mailer and the
 * live preview in Settings > Email templates). A company's own text, when it has saved one (public.email_templates, migration 106),
 * replaces the default; with no saved text, or 106 not applied, the default below is used.
 *
 * The default texts are the wording the app used before templates existed, moved here unchanged. Placeholders are `{{name}}`:
 *   - a placeholder with a value is replaced by it ("" is a value: the placeholder disappears);
 *   - a placeholder with no value (unknown, or not given for this e-mail) stays visible as `{{name}}`, so a mistake shows in the
 *     preview and in the draft instead of vanishing;
 *   - the HTML version escapes everything (the template text and the values), then turns line breaks into <br>.
 * No conditionals: where the old text varied (a greeting with or without the contact's name, a sentence only when part paid), the
 * vars builders below compute the piece as one placeholder value.
 */

export const TEMPLATE_KEYS = ["quote", "invoice", "purchase_order", "delivery_note", "invoice_reminder", "timesheet", "job_to_workshop", "rfq_clarify"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const PLACEHOLDERS = [
  "customer_name", "document_number", "total", "due_date", "company_name", "days_overdue", "person_name", "week", "hours", "link",
  // Needed to keep the existing wording of the delivery note, chaser and workshop texts.
  "greeting", "payment_note", "job", "delivery_date", "status", "description",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type TemplateVars = Partial<Record<string, string>>;
export type TemplateText = { subject: string; body: string };
export type RenderedTemplate = { subject: string; text: string; html: string };

export const SUBJECT_MAX = 200;
export const BODY_MAX = 10_000;

export type TemplateDefinition = TemplateText & {
  label: string;
  /** Where the app uses it. */
  usedFor: string;
  /** The placeholders this e-mail fills in (shown under the editor). */
  placeholders: Placeholder[];
};

export const DEFAULT_TEMPLATES: Record<TemplateKey, TemplateDefinition> = {
  quote: {
    label: "Quote",
    usedFor: "Sending a quote to the customer (Quotes > Send).",
    placeholders: ["document_number", "company_name", "customer_name", "total", "link"],
    subject: "Quote {{document_number}} from {{company_name}}",
    body: "Hello,\n\nPlease find our quote {{document_number}} attached as a PDF.\n\nKind regards,\n{{company_name}}",
  },
  invoice: {
    label: "Invoice",
    usedFor: "Sending an invoice to the customer (Invoices > Send).",
    placeholders: ["document_number", "company_name", "customer_name", "total", "due_date", "link"],
    subject: "Invoice {{document_number}} from {{company_name}}",
    body: "Hello,\n\nPlease find our invoice {{document_number}} attached as a PDF.\n\nKind regards,\n{{company_name}}",
  },
  purchase_order: {
    label: "Purchase order",
    usedFor: "Sending a purchase order to the supplier (Purchase orders > Email).",
    placeholders: ["document_number", "company_name", "customer_name", "total", "due_date", "link"],
    subject: "Purchase order {{document_number}} from {{company_name}}",
    body: "Hello,\n\nPlease find our purchase order {{document_number}} attached as a PDF.\n\nKind regards,\n{{company_name}}",
  },
  delivery_note: {
    label: "Delivery note",
    usedFor: "Emailing a delivery note to the customer (Delivery notes > Email).",
    placeholders: ["document_number", "company_name", "customer_name", "job", "delivery_date", "status", "link"],
    subject: "Delivery Note {{document_number}} from {{company_name}}",
    body: "Hi Team,\n\nPlease find delivery note {{document_number}} from {{company_name}}.\n\nCustomer: {{customer_name}}\nJob: {{job}}\nDelivery date: {{delivery_date}}\nStatus: {{status}}\n\nBest regards,\n{{company_name}}",
  },
  invoice_reminder: {
    label: "Overdue invoice reminder",
    usedFor: "Chasing an overdue invoice (Invoices > Chase overdue, and scheduled reminders).",
    placeholders: ["greeting", "document_number", "total", "due_date", "days_overdue", "payment_note", "company_name", "customer_name", "person_name"],
    subject: "Overdue invoice {{document_number}} from {{company_name}}",
    body: "{{greeting}},\n\nOur records show invoice {{document_number}} for {{total}} was due on {{due_date}} and is now {{days_overdue}} overdue.{{payment_note}}\n\nPlease arrange payment, or let us know if there is a problem with the invoice.\n\nKind regards,\n{{company_name}}",
  },
  timesheet: {
    label: "Weekly timesheet",
    usedFor: "The weekly timesheet e-mail to admins (scheduled).",
    placeholders: ["week", "hours", "person_name", "company_name", "link"],
    subject: "Timesheet for week {{week}} from {{company_name}}",
    body: "Hello,\n\nThe timesheet for week {{week}} is ready: {{hours}} hours recorded.\n\n{{link}}\n\nKind regards,\n{{company_name}}",
  },
  job_to_workshop: {
    label: "Job sheet to workshop",
    usedFor: "Sending a job sheet to the workshop (Jobs > Send to workshop).",
    placeholders: ["document_number", "customer_name", "description", "due_date"],
    subject: "JOB SHEET - {{document_number}} - {{customer_name}}",
    body: "{{document_number}}\n{{customer_name}}\n{{description}}\nDue: {{due_date}}",
  },
  rfq_clarify: {
    label: "RFQ clarification",
    usedFor: "Asking a customer to clarify an RFQ (RFQs > Clarify).",
    placeholders: ["company_name", "customer_name", "document_number"],
    subject: "Clarification needed for RFQ",
    body: "Hi,\n\nThanks for the RFQ. Before quoting, could you please confirm the missing details below?\n\nBest regards,\n{{company_name}}",
  },
};

/** Example values for the live preview in Settings (never real data). */
export const SAMPLE_VARS: Record<Placeholder, string> = {
  customer_name: "Acme Engineering Ltd",
  document_number: "Q-1042",
  total: "£1,250.00",
  due_date: "30/11/2026",
  company_name: "Your Company Ltd",
  days_overdue: "5 days",
  person_name: "Jane Smith",
  week: "45",
  hours: "37.5",
  link: "https://app.example.com/documents/Q-1042",
  greeting: "Hello Jane Smith",
  payment_note: " We have received £250.00, leaving £1,000.00 to pay.",
  job: "J-2210",
  delivery_date: "28/10/2026",
  status: "Delivered",
  description: "10 x flange, 316 stainless",
};

export const isTemplateKey = (value: unknown): value is TemplateKey => typeof value === "string" && (TEMPLATE_KEYS as readonly string[]).includes(value);

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Replaces each `{{name}}` that has a value; leaves the others visible as `{{name}}`. */
export function fillPlaceholders(text: string, vars: TemplateVars): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    return typeof value === "string" ? value : `{{${name}}}`;
  });
}

/** The placeholder names a text uses that this app does not know (shown as a warning under the editor). */
export function unknownPlaceholders(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) if (!(PLACEHOLDERS as readonly string[]).includes(match[1])) names.add(match[1]);
  return [...names];
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** One line: CR, LF and other line breaks become a space (a subject is an e-mail header). */
export const oneLine = (text: string) => text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();

/**
 * The e-mail for `key`: the company's own text (`override`, when it has a non-blank subject or body) or the default, with `vars`
 * filled in. Each of subject and body falls back to the default on its own when the saved one is blank.
 */
export function renderTemplate(key: TemplateKey, vars: TemplateVars, override?: Partial<TemplateText> | null): RenderedTemplate {
  const base = DEFAULT_TEMPLATES[key];
  const subject = override?.subject?.trim() ? override.subject : base.subject;
  const body = override?.body?.trim() ? override.body : base.body;
  const text = fillPlaceholders(body, vars);
  return {
    subject: oneLine(fillPlaceholders(subject, vars)).slice(0, SUBJECT_MAX),
    text,
    html: escapeHtml(text).replace(/\r?\n/g, "<br>\n"),
  };
}

// ---- Vars builders: the formatting the old hard-coded texts did, in one place.

/** "1 day" / "5 days". */
export const daysText = (days: number) => `${days} day${days === 1 ? "" : "s"}`;

/** The overdue invoice reminder's values. Money and dates already formatted by the caller (currency(), fmtDate()). */
export function invoiceReminderVars(input: {
  reference: string; total: string; dueDate: string; daysOverdue: number; companyName: string; customerName: string;
  contactName?: string | null; amountPaid?: number; paidText?: string; balanceText?: string;
}): TemplateVars {
  const contact = input.contactName?.trim() || "";
  return {
    greeting: contact ? `Hello ${contact}` : "Hello",
    person_name: contact,
    customer_name: input.customerName,
    document_number: input.reference,
    total: input.total,
    due_date: input.dueDate,
    days_overdue: daysText(input.daysOverdue),
    payment_note: (input.amountPaid ?? 0) > 0 && input.paidText && input.balanceText ? ` We have received ${input.paidText}, leaving ${input.balanceText} to pay.` : "",
    company_name: input.companyName,
  };
}
