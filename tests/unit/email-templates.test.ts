/**
 * E11 company e-mail templates (lib/email/templates, components/email/email-templates-card, migration 106):
 *   - renderTemplate: placeholders filled, an unknown or unfilled placeholder stays visible, "" removes it, HTML escaped, the subject
 *     one line, the company's own text before the default (each of subject and body on its own).
 *   - The defaults are the wording the app used before (the old hard-coded strings, rebuilt here, must come out byte for byte).
 *   - The store: 106 not applied answers "not applied" / no override quietly (no throw, no console line); saves send the company and
 *     key; friendly messages for refusals.
 *   - The Settings card: the preview shows the rendered text; the not-applied message; read-only without office or admin.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/supabase-business", () => ({ getCurrentOrganizationId: async () => "org-1" }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: "office" }) }));

import { EmailTemplateEditor, EmailTemplatesBody, editorText } from "@/components/email/email-templates-card";
import {
  DEFAULT_TEMPLATES, PLACEHOLDERS, SAMPLE_VARS, TEMPLATE_KEYS, fillPlaceholders, invoiceReminderVars, isTemplateKey, renderTemplate, unknownPlaceholders,
} from "@/lib/email/templates/defaults";
import {
  TEMPLATES_NOT_APPLIED_MESSAGE, isMissingTableError, loadTemplateOverride, loadTemplateOverrides, resetTemplateOverride, saveTemplateOverride, templateProblem,
} from "@/lib/email/templates/store";

afterEach(() => vi.restoreAllMocks());

describe("renderTemplate", () => {
  it("fills placeholders, keeps unknown and unfilled ones visible, and removes one whose value is empty", () => {
    expect(fillPlaceholders("Hi {{customer_name}}, {{ document_number }} {{nope}} {{total}}.", { customer_name: "Acme", document_number: "Q-1" }))
      .toBe("Hi Acme, Q-1 {{nope}} {{total}}.");
    expect(fillPlaceholders("A{{payment_note}}B", { payment_note: "" })).toBe("AB");
    expect(fillPlaceholders("{{constructor}} {{__proto__}}", {})).toBe("{{constructor}} {{__proto__}}");
    expect(unknownPlaceholders("{{customer_name}} {{customr_name}} {{x}} {{x}}")).toEqual(["customr_name", "x"]);
  });

  it("escapes HTML in the html version (template text and values) and keeps the text version as typed", () => {
    const out = renderTemplate("quote", { document_number: "<b>Q&1</b>", company_name: "\"Acme\" 'Ltd'" }, { subject: "S", body: "<i>{{document_number}}</i>\nfrom {{company_name}}" });
    expect(out.text).toBe("<i><b>Q&1</b></i>\nfrom \"Acme\" 'Ltd'");
    expect(out.html).toBe("&lt;i&gt;&lt;b&gt;Q&amp;1&lt;/b&gt;&lt;/i&gt;<br>\nfrom &quot;Acme&quot; &#39;Ltd&#39;");
    expect(out.html).not.toMatch(/<(?!br>)/);
  });

  it("the subject is always one line (a value or saved text with CR/LF can't add a header)", () => {
    const out = renderTemplate("invoice", { document_number: "I-1\r\nBcc: evil@example.com", company_name: "Acme" });
    expect(out.subject).toBe("Invoice I-1 Bcc: evil@example.com from Acme");
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(renderTemplate("invoice", {}, { subject: "x".repeat(500), body: "b" }).subject).toHaveLength(200);
  });

  it("the company's own text comes before the default; a blank saved subject or body falls back on its own", () => {
    const vars = { document_number: "Q-9", company_name: "Acme" };
    expect(renderTemplate("quote", vars).subject).toBe("Quote Q-9 from Acme");
    expect(renderTemplate("quote", vars, { subject: "Your quote {{document_number}}", body: "Custom {{company_name}}" })).toMatchObject({ subject: "Your quote Q-9", text: "Custom Acme" });
    expect(renderTemplate("quote", vars, { subject: "  ", body: "Custom" })).toMatchObject({ subject: "Quote Q-9 from Acme", text: "Custom" });
    expect(renderTemplate("quote", vars, { subject: "Mine", body: "" }).text).toBe("Hello,\n\nPlease find our quote Q-9 attached as a PDF.\n\nKind regards,\nAcme");
    expect(renderTemplate("quote", vars, null).subject).toBe("Quote Q-9 from Acme");
  });

  it("knows exactly the eight keys of the contract, each with a label and only known placeholders", () => {
    expect([...TEMPLATE_KEYS]).toEqual(["quote", "invoice", "purchase_order", "delivery_note", "invoice_reminder", "timesheet", "job_to_workshop", "rfq_clarify"]);
    for (const key of TEMPLATE_KEYS) {
      const d = DEFAULT_TEMPLATES[key];
      expect(d.label).toBeTruthy();
      expect(unknownPlaceholders(`${d.subject}\n${d.body}`)).toEqual([]);
      for (const p of d.placeholders) expect(PLACEHOLDERS).toContain(p);
      // The sample data fills every placeholder of every default: the preview never shows a {{name}}.
      const preview = renderTemplate(key, SAMPLE_VARS);
      expect(`${preview.subject}${preview.text}`).not.toMatch(/\{\{/);
    }
    expect(isTemplateKey("alert")).toBe(false);
    expect(isTemplateKey("quote")).toBe(true);
  });
});

describe("the defaults keep the wording the app used before", () => {
  const company = "Acme Ltd";
  it("quote, invoice (Send)", () => {
    const ref = "Q-1";
    expect(renderTemplate("quote", { document_number: ref, company_name: company })).toMatchObject({
      subject: `Quote ${ref} from ${company}`, text: `Hello,\n\nPlease find our quote ${ref} attached as a PDF.\n\nKind regards,\n${company}` });
    expect(renderTemplate("invoice", { document_number: "I-7", company_name: company })).toMatchObject({
      subject: `Invoice I-7 from ${company}`, text: `Hello,\n\nPlease find our invoice I-7 attached as a PDF.\n\nKind regards,\n${company}` });
  });

  it("the overdue chaser, with and without a contact name and a part payment", () => {
    const old = (contact: string | undefined, days: number, paid: number) =>
      `Hello${contact ? ` ${contact}` : ""},\n\nOur records show invoice I-1 for £100.00 was due on 01/10/2026 and is now ${days} day${days === 1 ? "" : "s"} overdue.${paid > 0 ? ` We have received £40.00, leaving £60.00 to pay.` : ""}\n\nPlease arrange payment, or let us know if there is a problem with the invoice.\n\nKind regards,\n${company}`;
    for (const [contact, days, paid] of [["Jane", 1, 0], [undefined, 5, 40], ["", 12, 40]] as const) {
      const out = renderTemplate("invoice_reminder", invoiceReminderVars({
        reference: "I-1", total: "£100.00", dueDate: "01/10/2026", daysOverdue: days, companyName: company, customerName: "Cust",
        contactName: contact, amountPaid: paid, paidText: "£40.00", balanceText: "£60.00",
      }));
      expect(out.text).toBe(old(contact, days, paid));
      expect(out.subject).toBe(`Overdue invoice I-1 from ${company}`);
    }
  });

  it("the delivery note e-mail, the workshop job sheet and the RFQ clarification", () => {
    expect(renderTemplate("delivery_note", { document_number: "DN-3", company_name: company, customer_name: "Cust", job: "No linked job", delivery_date: "02/10/2026", status: "pending" })).toMatchObject({
      subject: `Delivery Note DN-3 from ${company}`,
      text: `Hi Team,\n\nPlease find delivery note DN-3 from ${company}.\n\nCustomer: Cust\nJob: No linked job\nDelivery date: 02/10/2026\nStatus: pending\n\nBest regards,\n${company}`,
    });
    expect(renderTemplate("job_to_workshop", { document_number: "J-1", customer_name: "Cust", description: "Flange", due_date: "03/10/2026" })).toMatchObject({
      subject: "JOB SHEET - J-1 - Cust", text: "J-1\nCust\nFlange\nDue: 03/10/2026" });
    expect(renderTemplate("rfq_clarify", { company_name: company })).toMatchObject({
      subject: "Clarification needed for RFQ", text: `Hi,\n\nThanks for the RFQ. Before quoting, could you please confirm the missing details below?\n\nBest regards,\n${company}` });
  });
});

/** A minimal Supabase stand-in for the email_templates calls the store makes. */
function client(answer: { data?: unknown; error?: { code?: string; message?: string } | null }, calls: unknown[] = []) {
  const result = { data: answer.data ?? null, error: answer.error ?? null };
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "delete"]) chain[name] = (...args: unknown[]) => { calls.push([name, ...args]); return chain; };
  chain.maybeSingle = async () => result;
  chain.upsert = async (...args: unknown[]) => { calls.push(["upsert", ...args]); return result; };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { from: (table: string) => { calls.push(["from", table]); return chain; } } as never;
}

describe("the store, with migration 106 not applied", () => {
  const missing = [{ code: "PGRST205", message: "Could not find the table 'public.email_templates' in the schema cache" }, { code: "42P01", message: "relation \"public.email_templates\" does not exist" }];

  it("reads as 'not applied' / no override, never throws, writes nothing to the console", async () => {
    const log = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    for (const error of missing) {
      expect(isMissingTableError(error)).toBe(true);
      expect(await loadTemplateOverrides(client({ error }))).toEqual({ status: "not_applied" });
      expect(await loadTemplateOverride(client({ error }), "invoice")).toBeNull();
      expect(await saveTemplateOverride(client({ error }), "org-1", "quote", { subject: "S", body: "B" })).toEqual({ ok: false, notApplied: true, message: TEMPLATES_NOT_APPLIED_MESSAGE });
      expect(await resetTemplateOverride(client({ error }), "org-1", "quote")).toMatchObject({ ok: false, notApplied: true });
    }
    // A sender with no override uses the default text.
    expect(renderTemplate("invoice", { document_number: "I-1", company_name: "A" }, await loadTemplateOverride(client({ error: missing[0] }), "invoice")).subject).toBe("Invoice I-1 from A");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a thrown client (offline) or no client is also just 'no override'", async () => {
    const throwing = { from: () => { throw new Error("Failed to fetch"); } } as never;
    expect(await loadTemplateOverride(throwing, "quote")).toBeNull();
    expect(await loadTemplateOverride(null, "quote")).toBeNull();
    expect(await loadTemplateOverrides(throwing)).toMatchObject({ status: "error" });
  });
});

describe("the store, with 106 applied", () => {
  it("loads saved rows by key, ignoring anything that isn't a known key", async () => {
    const data = [{ key: "quote", subject: "S", body: "B", updated_at: "2026-10-30T10:00:00Z" }, { key: "alert", subject: "x", body: "y", updated_at: null }];
    expect(await loadTemplateOverrides(client({ data }))).toEqual({ status: "ok", overrides: { quote: { subject: "S", body: "B", updatedAt: "2026-10-30T10:00:00Z" } } });
  });

  it("saves one row per company and key (trimmed); checks the text first; friendly refusal messages", async () => {
    const calls: unknown[] = [];
    expect(await saveTemplateOverride(client({}, calls), "org-1", "invoice", { subject: " Inv {{document_number}} ", body: " Body " })).toEqual({ ok: true });
    expect(calls).toContainEqual(["upsert", { organization_id: "org-1", key: "invoice", subject: "Inv {{document_number}}", body: "Body" }, { onConflict: "organization_id,key" }]);
    expect(templateProblem({ subject: "a\nb", body: "x" })).toMatch(/one line/);
    expect(templateProblem({ subject: "", body: "x" })).toMatch(/subject/);
    expect(templateProblem({ subject: "s", body: "  " })).toMatch(/text/);
    const none: unknown[] = [];
    expect(await saveTemplateOverride(client({}, none), "org-1", "invoice", { subject: "", body: "x" })).toMatchObject({ ok: false, notApplied: false });
    expect(none).toEqual([]);
    expect(await saveTemplateOverride(client({ error: { code: "42501", message: "new row violates row-level security policy" } }), "org-1", "quote", { subject: "S", body: "B" }))
      .toEqual({ ok: false, notApplied: false, message: "You don't have permission to change e-mail templates. Ask an admin or office user." });
    const reset: unknown[] = [];
    expect(await resetTemplateOverride(client({}, reset), "org-1", "quote")).toEqual({ ok: true });
    expect(reset).toEqual([["from", "email_templates"], ["delete"], ["eq", "organization_id", "org-1"], ["eq", "key", "quote"]]);
  });
});

describe("Settings > Email templates", () => {
  const noop = () => undefined;
  it("the preview is the rendered text of what is in the editor (example details)", () => {
    const html = renderToStaticMarkup(createElement(EmailTemplateEditor, {
      templateKey: "quote", value: { subject: "Quote {{document_number}} for {{customer_name}}", body: "Dear {{person_name}}\n<b>{{nope}}</b>" },
      custom: true, dirty: true, canEdit: true, busy: false, onChange: noop, onSave: noop, onReset: noop,
    }));
    expect(html).toContain(`Quote ${SAMPLE_VARS.document_number} for ${SAMPLE_VARS.customer_name}`);
    expect(html).toContain(`Dear ${SAMPLE_VARS.person_name}\n&lt;b&gt;{{nope}}&lt;/b&gt;`);
    expect(html).toContain("Not a placeholder this e-mail fills in");
    expect(html).toContain("Reset to default");
    expect(html).toContain(">Save<");
    expect(html).toContain("unsaved changes");
  });

  it("read-only without office or admin: no Save or Reset", () => {
    const html = renderToStaticMarkup(createElement(EmailTemplatesBody, { state: { status: "ready" }, canEdit: false, overrides: {}, drafts: {}, busyKey: null, onChange: noop, onSave: noop, onReset: noop }));
    expect(html).toContain("Only office and admin users can change these.");
    expect(html).not.toContain("Reset to default");
    expect(html).toContain("readOnly");
    for (const key of TEMPLATE_KEYS) expect(html).toContain(`data-testid="email-template-${key}"`);
  });

  it("before database update 106: says so, and no editors", () => {
    const html = renderToStaticMarkup(createElement(EmailTemplatesBody, { state: { status: "not_applied" }, canEdit: true, overrides: {}, drafts: {}, busyKey: null, onChange: noop, onSave: noop, onReset: noop }));
    expect(html).toContain("Not available until database update 106 is applied.");
    expect(html).not.toContain("email-template-quote");
  });

  it("the editor shows the draft, else the saved text, else the default", () => {
    const saved = { subject: "Saved", body: "Saved body", updatedAt: null };
    expect(editorText("quote", {}, {})).toEqual({ subject: DEFAULT_TEMPLATES.quote.subject, body: DEFAULT_TEMPLATES.quote.body });
    expect(editorText("quote", {}, { quote: saved })).toBe(saved);
    expect(editorText("quote", { quote: { subject: "Draft", body: "D" } }, { quote: saved })).toEqual({ subject: "Draft", body: "D" });
  });
});
