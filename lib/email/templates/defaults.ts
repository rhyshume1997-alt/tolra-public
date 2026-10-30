// stub: replaced by EA at merge. E11 owns lib/email/templates/defaults.ts (every default text, one renderTemplate). This stub carries only
// the two keys the e-mail schedules use, with the contract's placeholder rule (an unknown placeholder stays visible as {{name}}), so the
// schedules compile and are testable. The schedules call renderTemplate only through lib/email/schedules/render.ts, the one place to adapt.
export type TemplateKey = "invoice_reminder" | "timesheet" | (string & {});
export type TemplateOverride = { subject: string; body: string };

const DEFAULTS: Record<string, TemplateOverride> = {
  invoice_reminder: {
    subject: "Reminder: invoice {{document_number}} from {{company_name}}",
    body: "Hello {{customer_name}},\n\nOur records show invoice {{document_number}} for {{total}} was due on {{due_date}} and is now {{days_overdue}} days overdue.\n\nPlease arrange payment, or let us know if there is a problem with the invoice.\n\nKind regards,\n{{company_name}}",
  },
  timesheet: {
    subject: "Timesheet for {{person_name}}, {{week}}",
    body: "Hours for {{person_name}}, {{week}}: {{hours}}.\n\n{{link}}\n\n{{company_name}}",
  },
};

export function renderTemplate(key: TemplateKey, vars: Record<string, string>, override?: TemplateOverride | null): TemplateOverride {
  const source = override ?? DEFAULTS[key] ?? { subject: "", body: "" };
  const fill = (text: string) => text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => (name in vars ? vars[name] : whole));
  return { subject: fill(source.subject), body: fill(source.body) };
}
