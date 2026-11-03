// 138: the job, parts and supplier FACTS behind the chase merge fields, and template rendering with and without job / order data. How the
// facts read (lib/chasing/templates.ts chaseJobVars) and the default wording are ChatGPT's (TODO-CHATGPT): these tests use the fields'
// values, and a company's own text, not the default sentences.
import { describe, expect, it } from "vitest";

import { CHASE_JOB_PLACEHOLDERS, CHASE_TONE_TEMPLATE, chaseJobVars } from "@/lib/chasing/templates";
import { chaseJobFacts } from "@/lib/email/chase/context";
import { PLACEHOLDERS, invoiceReminderVars, renderTemplate } from "@/lib/email/templates/defaults";

const job = { job_no: "J-2210", stage: "machining", status: "on_track", finished_at: null };
const po = (status: string, expected: string | null, received_at: string | null = null) => ({ status, expected_delivery: expected, received_at });
const vars = (facts: ReturnType<typeof chaseJobFacts>) => invoiceReminderVars({
  reference: "INV-1042", total: "£1,200.00", dueDate: "20/11/2026", daysOverdue: 0, companyName: "JNR", customerName: "Acme Ltd", balanceText: "£1,200.00", job: chaseJobVars(facts),
});
const own = { subject: "{{document_number}} {{job_number}}", body: "A{{job_number}}B{{job_status}}C{{parts_expected}}D{{parts_status}}E{{job_note}}F" };

describe("job and parts facts", () => {
  it("no job (or no job number): null", () => {
    expect(chaseJobFacts(null)).toBeNull();
    expect(chaseJobFacts({ ...job, job_no: "  " })).toBeNull();
  });
  it("a job with no supplier orders: number and state; parts unknown", () => {
    expect(chaseJobFacts(job)).toEqual({ jobNumber: "J-2210", jobState: "Machining", partsAwaited: null, partsExpected: null });
    expect(chaseJobFacts({ ...job, finished_at: "2026-11-01T10:00:00Z" })!.jobState).toBe("Complete");
    expect(chaseJobFacts({ ...job, stage: "nonsense" })!.jobState).toBe("");
  });
  it("parts awaited: the latest expected date among awaited orders, as a UK date; drafts, cancelled and received orders don't count as awaited", () => {
    expect(chaseJobFacts(job, [po("sent", "2026-11-12"), po("sent", "2026-11-19"), po("received", "2026-12-01", "2026-11-01T00:00:00Z"), po("draft", "2027-01-01"), po("cancelled", "2027-02-01")]))
      .toMatchObject({ partsAwaited: true, partsExpected: "19/11/2026" });
    expect(chaseJobFacts(job, [po("sent", null)])).toMatchObject({ partsAwaited: true, partsExpected: null });
    expect(chaseJobFacts(job, [po("received", "2026-11-12", "2026-11-10T00:00:00Z")])).toMatchObject({ partsAwaited: false, partsExpected: null });
    expect(chaseJobFacts(job, [po("sent", "2026-11-12", "2026-11-11T00:00:00Z")])).toMatchObject({ partsAwaited: false });
    expect(chaseJobFacts(job, [po("draft", "2026-11-12"), po("cancelled", null)])).toMatchObject({ partsAwaited: null });
  });
});

describe("rendering with and without job / order data", () => {
  it("every job field is a known placeholder and is always filled (\"\" without a job), so no {{...}} is left", () => {
    for (const name of CHASE_JOB_PLACEHOLDERS) expect(PLACEHOLDERS).toContain(name);
    const mail = renderTemplate("chase_firm", vars(null), own);
    expect(mail).toMatchObject({ subject: "INV-1042", text: "ABCDEF" });
  });
  it("with a job and an awaited order the values are there", () => {
    const mail = renderTemplate("chase_firm", vars(chaseJobFacts(job, [po("sent", "2026-11-12")])), own);
    expect(mail.subject).toBe("INV-1042 J-2210");
    expect(mail.text.startsWith("AJ-2210BMachiningC12/11/2026D")).toBe(true);
  });
  it("the four tones' default texts render with no placeholder left, with or without a job", () => {
    for (const key of Object.values(CHASE_TONE_TEMPLATE)) for (const v of [vars(null), vars(chaseJobFacts(job, [po("sent", "2026-11-12")]))]) {
      const mail = renderTemplate(key, v);
      expect(`${mail.subject}${mail.text}${mail.html}`).not.toContain("{{");
    }
  });
});
