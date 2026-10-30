// The one place the schedules turn a template key and its values into a subject and a text body, through E11's renderTemplate
// (lib/email/templates/defaults.ts). A company's own wording (migration 106's email_templates) is passed in as `override`.
import { renderTemplate } from "@/lib/email/templates/defaults";

export type RenderedEmail = { subject: string; text: string };

export function renderScheduleEmail(key: "invoice_reminder" | "timesheet", vars: Record<string, string>, override?: { subject: string; body: string } | null): RenderedEmail {
  const out = renderTemplate(key, vars, override ?? undefined) as { subject: string; body?: string; text?: string };
  return { subject: out.subject, text: out.body ?? out.text ?? "" };
}
