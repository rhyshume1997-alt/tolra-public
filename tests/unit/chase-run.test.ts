// 138: one chase pass for one company. Drafts only (createDraft = public.chase_create_draft; no mailer is reachable from here), the step
// due by date (a before-due step included), pauses, the right company, the tone's template and the job / parts wording.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Which steps are due is ChatGPT's (lib/chasing/steps.ts, TODO-CHATGPT): the pass drafts exactly what dueChaseSteps returns. The stub
// runs by default; a test that needs a particular answer sets it.
const dueSpy = vi.hoisted(() => ({ override: null as null | ((...args: unknown[]) => unknown) }));
vi.mock("@/lib/chasing/steps", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/chasing/steps")>();
  return { ...real, dueChaseSteps: (...args: Parameters<typeof real.dueChaseSteps>) => (dueSpy.override ? dueSpy.override(...args) : real.dueChaseSteps(...args)) };
});

import { type ChaseDeps, CHASE_NOT_APPLIED, chaseCandidates, runChase } from "@/lib/email/chase/run";
import { FakeDb } from "../support/fake-db";

const ORG = "org-a";
const inv = (id: string, extra: Record<string, unknown> = {}) => ({
  id, organization_id: ORG, invoice_ref: `INV-${id}`, customer: "Acme Ltd", job_id: null, total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0,
  status: "sent", due_date: "2026-11-05", payment_unverified: false, ...extra,
});
const createDraft = vi.fn<NonNullable<ChaseDeps["createDraft"]>>();
let db: FakeDb;
const run = (today: string, extra: Partial<Parameters<typeof runChase>[1]> = {}) => runChase(db as never, { organizationId: ORG, today, ...extra }, { createDraft });

beforeEach(() => {
  dueSpy.override = null;
  createDraft.mockReset();
  createDraft.mockImplementation(async (_admin, args) => ({ created: true, history_id: `h-${args.invoiceId}-${args.stepId}` }));
  db = new FakeDb({
    invoices: [inv("1")],
    customers: [{ id: "c1", organization_id: ORG, name: "Acme Ltd", email: "pay@acme.test", contact_name: "Pat" }, { id: "c9", organization_id: "org-b", name: "Acme Ltd", email: "other@b.test" }],
    chase_steps: [
      { id: "b3", organization_id: ORG, offset_days: -3, tone: "before_due" }, { id: "f7", organization_id: ORG, offset_days: 7, tone: "friendly" },
      { id: "m14", organization_id: ORG, offset_days: 14, tone: "firm" }, { id: "x30", organization_id: ORG, offset_days: 30, tone: "final" },
      { id: "other", organization_id: "org-b", offset_days: -10, tone: "before_due" },
    ],
    chase_pauses: [], chase_sends: [], jobs: [], purchase_orders: [], email_templates: [],
    organizations: [{ id: ORG, name: "JNR Engineering" }], organization_settings: [{ organization_id: ORG, company_profile: { name: "JNR" } }],
  });
});

describe("the chase pass drafts the step due today", () => {
  it("3 days before due: the before-due nudge, with the before-due text, to the customer on file", async () => {
    const out = await run("2026-11-02");
    expect(out).toMatchObject({ sent: 0, drafted: 1, skipped: 0, failed: 0, error: null });
    const args = createDraft.mock.calls[0][1];
    expect(args).toMatchObject({ organizationId: ORG, invoiceId: "1", stepId: "b3", to: "pay@acme.test", toName: "Pat", userId: null });
    expect(args.body).not.toContain("{{");
    expect(args.body).toContain("INV-1"); // the before-due template (its wording is ChatGPT's)
  });
  it("4 days before due: nothing yet (another company's -10 step is not this company's)", async () => {
    expect(await run("2026-11-01")).toMatchObject({ drafted: 0, skipped: 0 });
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("drafts exactly the steps the selection returns, each in its tone's template, and passes it the invoice's history", async () => {
    db.rows("chase_sends").push({ organization_id: ORG, invoice_id: "1", step_id: "b3", offset_days: -3 });
    db.rows("email_templates").push({ organization_id: ORG, key: "chase_firm", subject: "Firm {{document_number}}", body: "Firm text" });
    const seen: unknown[] = [];
    dueSpy.override = (steps, daysFromDue, history) => { seen.push([daysFromDue, history]); return (steps as Array<{ id: string }>).filter((s) => s.id === "m14"); };
    await run("2026-11-19");
    expect(seen).toEqual([[14, { stepIds: ["b3"], offsets: [-3] }]]);
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][1]).toMatchObject({ stepId: "m14", subject: "Firm INV-1", body: "Firm text" });
  });
  it("nothing due: skipped as no_step_due; the person who pressed the button is the drafter", async () => {
    dueSpy.override = () => [];
    expect(await run("2026-11-13", { userId: "u-1" })).toMatchObject({ drafted: 0, skipped: 1, reasons: { no_step_due: 1 } });
    dueSpy.override = (steps) => (steps as Array<{ id: string }>).filter((s) => s.id === "f7");
    await run("2026-11-13", { userId: "u-1" });
    expect(createDraft.mock.calls[0][1]).toMatchObject({ stepId: "f7", userId: "u-1" });
  });
  it("the database's answer is final: a step it refuses is counted as skipped with its reason", async () => {
    dueSpy.override = (steps) => (steps as Array<{ id: string }>).filter((s) => s.id === "f7");
    createDraft.mockResolvedValueOnce({ created: false, reason: "invoice_paused" });
    expect(await run("2026-11-13")).toMatchObject({ drafted: 0, skipped: 1, reasons: { invoice_paused: 1 } });
  });
});

describe("never chased", () => {
  it.each([
    ["paid", { status: "paid", amount_paid: 120 }], ["void", { status: "void" }], ["credited", { status: "credited" }], ["written off", { status: "written_off" }],
    ["a draft", { status: "draft", invoice_ref: null }], ["a payment to confirm", { payment_unverified: true }], ["no balance", { amount_paid: 60, credited_amount: 60 }],
    ["no due date", { due_date: null }], ["a payment claim open (the customer says they've paid)", { payment_claimed_at: "2026-11-10T09:00:00Z" }],
  ])("%s", async (_name, change) => {
    db.tables.invoices = [inv("1", change)];
    expect((await run("2026-11-20")).drafted).toBe(0);
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("chasing paused on the invoice (until a date, inclusive), then resumed after it", async () => {
    db.rows("chase_pauses").push({ organization_id: ORG, invoice_id: "1", customer_id: null, paused_until: "2026-11-13" });
    expect(await run("2026-11-13")).toMatchObject({ drafted: 0, reasons: { invoice_paused: 1 } });
    expect((await run("2026-11-14")).drafted).toBeGreaterThan(0);
  });
  it("chasing paused for the customer (by name, any case): none of its invoices", async () => {
    db.rows("invoices").push(inv("2", { customer: " ACME LTD " }));
    db.rows("chase_pauses").push({ organization_id: ORG, invoice_id: null, customer_id: "c1", paused_until: null });
    expect(await run("2026-11-13")).toMatchObject({ drafted: 0, reasons: { customer_paused: 2 } });
  });
  it("no steps saved: nothing; 138 not applied: nothing, and the run says so", async () => {
    db.tables.chase_steps = [];
    expect(await run("2026-11-20")).toMatchObject({ drafted: 0, error: null });
    db.failing.chase_steps = { code: "PGRST205", message: "Could not find the table 'public.chase_steps' in the schema cache" };
    expect(await run("2026-11-20")).toMatchObject({ drafted: 0, error: CHASE_NOT_APPLIED, retryable: false });
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("a customer with no address is skipped; fixed recipients are used instead when set", async () => {
    dueSpy.override = (steps) => (steps as Array<{ id: string }>).filter((s) => s.id === "f7");
    db.tables.customers = [];
    expect(await run("2026-11-13")).toMatchObject({ drafted: 0, reasons: { no_address: 1 } });
    await run("2026-11-13", { recipients: ["collections@jnr.test", "not an address"] });
    expect(createDraft.mock.calls[0][1]).toMatchObject({ to: "collections@jnr.test", toName: null });
  });
});

describe("job and supplier wording", () => {
  it("an invoice with a job, an awaited order on the job and one on its quote: the latest expected date", async () => {
    db.tables.invoices = [inv("1", { job_id: "j1" })];
    db.rows("jobs").push({ id: "j1", organization_id: ORG, job_no: "J-0042", stage: "inspection", status: "on_track", finished_at: null, quote_id: "q1" });
    db.rows("purchase_orders").push(
      { id: "p1", organization_id: ORG, job_id: "j1", quote_id: null, status: "sent", received_at: null, expected_delivery: "2026-11-10" },
      { id: "p2", organization_id: ORG, job_id: null, quote_id: "q1", status: "sent", received_at: null, expected_delivery: "2026-11-18" },
      { id: "p3", organization_id: "org-b", job_id: "j1", quote_id: null, status: "sent", received_at: null, expected_delivery: "2027-01-01" },
    );
    db.rows("email_templates").push({ organization_id: ORG, key: "invoice_reminder", subject: "{{document_number}}", body: "{{job_number}}|{{job_status}}|{{parts_expected}}" });
    dueSpy.override = (steps) => (steps as Array<{ id: string }>).filter((s) => s.id === "f7");
    await run("2026-11-13");
    expect(createDraft.mock.calls[0][1].body).toBe("J-0042|Inspection|18/11/2026");
  });
  it("the company's own wording for a tone is used", async () => {
    db.rows("email_templates").push({ organization_id: ORG, key: "chase_final", subject: "Last call {{document_number}}", body: "Pay {{balance}} now." });
    dueSpy.override = (steps) => (steps as Array<{ id: string }>).filter((s) => s.id === "x30");
    await run("2026-12-10");
    expect(createDraft.mock.calls[0][1]).toMatchObject({ stepId: "x30", subject: "Last call INV-1", body: "Pay £120.00 now." });
  });
});

describe("candidates", () => {
  it("money is exact to the penny: 100.10 - 33.37 - 66.73 leaves nothing", () => {
    expect(chaseCandidates([inv("1", { total: "100.10", amount_paid: "33.37", credited_amount: "66.73" }) as never], "2026-11-20", -3)).toEqual([]);
    expect(chaseCandidates([inv("1", { total: "100.10", amount_paid: "33.37", credited_amount: "66.72" }) as never], "2026-11-20", -3)[0].balance).toBe(0.01);
  });
});
