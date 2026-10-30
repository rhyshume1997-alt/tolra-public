// The one place the schedules turn a template key and its values into a subject and a text body, through E11's renderTemplate and the vars
// builders (lib/email/templates/defaults.ts: invoiceReminderVars, timesheetVars), so the placeholders the default texts use are always
// filled (a literal "{{greeting}}" must never reach a customer). A company's own wording (migration 106's email_templates) is `override`.
import { type TemplateText, invoiceReminderVars, renderTemplate, timesheetVars } from "@/lib/email/templates/defaults";

export type RenderedEmail = { subject: string; text: string; html: string };

export function renderInvoiceReminder(input: Parameters<typeof invoiceReminderVars>[0], override?: TemplateText | null): RenderedEmail {
  return renderTemplate("invoice_reminder", invoiceReminderVars(input), override);
}

export function renderTimesheet(input: Parameters<typeof timesheetVars>[0], override?: TemplateText | null): RenderedEmail {
  return renderTemplate("timesheet", timesheetVars(input), override);
}
