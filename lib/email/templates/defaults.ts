// replaced at merge: E11 owns lib/email/templates/defaults.ts (every default text, renderTemplate, the vars builders). This shim carries only
// what the e-mail schedules use (the invoice_reminder and timesheet texts and their vars builders), with E11's exact signatures and result
// shape ({ subject, text, html }), so the schedules compile and are testable on this branch. The schedules reach it only through
// lib/email/schedules/render.ts. If E11's file lacks a name below at merge time, the missing one moves there (E8 adds timesheetVars).
export type TemplateKey = "invoice_reminder" | "timesheet" | (string & {});
export type TemplateVars = Partial<Record<string, string>>;
export type TemplateText = { subject: string; body: string };
export type RenderedTemplate = { subject: string; text: string; html: string };

const DEFAULTS: Record<string, TemplateText> = {
  invoice_reminder: {
    subject: "Overdue invoice {{document_number}} from {{company_name}}",
    body: "{{greeting}},\n\nOur records show invoice {{document_number}} for {{total}} was due on {{due_date}} and is now {{days_overdue}} overdue.{{payment_note}}\n\nPlease arrange payment, or let us know if there is a problem with the invoice.\n\nKind regards,\n{{company_name}}",
  },
  timesheet: {
    subject: "Timesheet for week {{week}} from {{company_name}}",
    body: "Hello,\n\nThe timesheet for week {{week}} is ready: {{hours}} hours recorded.\n\n{{link}}\n\nKind regards,\n{{company_name}}",
  },
};

function fill(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    return typeof value === "string" ? value : `{{${name}}}`;
  });
}
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderTemplate(key: TemplateKey, vars: TemplateVars, override?: Partial<TemplateText> | null): RenderedTemplate {
  const base = DEFAULTS[key] ?? { subject: "", body: "" };
  const subject = override?.subject?.trim() ? override.subject : base.subject;
  const body = override?.body?.trim() ? override.body : base.body;
  const text = fill(body, vars);
  return { subject: fill(subject, vars).replace(/[\r\n\u2028\u2029]+/g, " ").trim().slice(0, 200), text, html: escapeHtml(text).replace(/\r?\n/g, "<br>\n") };
}

/** "1 day" / "5 days". */
export const daysText = (days: number) => `${days} day${days === 1 ? "" : "s"}`;

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

/** The weekly timesheet e-mail's values. Hours already formatted (decimal hours, "37.5"). */
export function timesheetVars(input: { personName: string; week: string; hours: string; companyName: string; link?: string }): TemplateVars {
  return { person_name: input.personName, week: input.week, hours: input.hours, company_name: input.companyName, link: input.link ?? "" };
}
