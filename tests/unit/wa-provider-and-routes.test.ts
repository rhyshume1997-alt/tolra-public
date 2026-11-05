// Worker W-A: fail closed (no automatic provider switch), drafts during a provider outage, chase approve failures/audit/override,
// and recipient binding by customer name in the direct-send routes. Mocks only.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const T = vi.hoisted(() => ({ tokenCalls: 0, tokenMode: "throw" as "throw" | "none" | "connected" }));
vi.mock("@/lib/integrations/microsoft/token-source", () => ({ getDelegatedAccessToken: async () => { T.tokenCalls += 1; if (T.tokenMode === "throw") throw new Error("refresh refused"); return T.tokenMode === "connected" ? "tok" : null; } }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => null }));

import { approveChaseDraft, type ApproveDeps } from "@/lib/email/chase/approve";
import { runInvoiceReminders } from "@/lib/email/schedules/reminders";
import { selectProvider, sendCompanyEmail } from "@/lib/email/send-company-email";
import { FakeDb } from "../support/fake-db";

const ENV = { RESEND_API_KEY: "re_fake_only", EMAIL_FROM: "Shop <billing@sender.test>" };

describe("fail closed: Microsoft problems never switch to Resend", () => {
  const resend = vi.fn(() => ({ name: "resend" as const, send: async () => ({ outcome: "accepted" as const, detail: "" }) }));
  beforeEach(() => { resend.mockClear(); });
  it("selectProvider rejects when the Microsoft token lookup throws, with Resend fully configured", async () => {
    await expect(selectProvider("o", { env: ENV, getToken: async () => { throw new Error("boom"); }, providers: { resend } })).rejects.toThrow("boom");
    expect(resend).not.toHaveBeenCalled();
  });
  it("sendCompanyEmail answers a provider_error (not uncertain) and never touches Resend or the ledger", async () => {
    const rpc = vi.fn();
    const out = await sendCompanyEmail({ organizationId: "o", userId: "u", kind: "quote", to: ["a@b.test"], subject: "s", text: "t" }, { env: ENV, getToken: async () => { throw new Error("boom"); }, providers: { resend }, db: { rpc } as never });
    expect(out).toMatchObject({ ok: false, code: "provider_error" });
    expect((out as { uncertain?: boolean }).uncertain).toBeUndefined();
    expect(resend).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a Microsoft send that is refused or unknown is not re-sent through Resend", async () => {
    for (const outcome of ["failed", "unknown"] as const) {
      const rpc = vi.fn(async (fn: string) => fn === "reserve_company_email" ? { data: { send_id: "s", history_id: "h", status: "sending", replay: false }, error: null } : { data: null, error: null });
      const out = await sendCompanyEmail({ organizationId: "o", userId: "u", kind: "quote", to: ["a@b.test"], subject: "s", text: "t" }, { env: ENV, getToken: async () => "tok", providers: { microsoft: () => ({ name: "microsoft", send: async () => ({ outcome, detail: "x" }) }), resend }, db: { rpc } as never });
      expect(out.ok).toBe(false);
    }
    expect(resend).not.toHaveBeenCalled();
  });
});

describe("the scheduled pass makes drafts while the provider is down", () => {
  it("drafts every due chase step, asks no provider, never sends", async () => {
    T.tokenMode = "throw"; T.tokenCalls = 0;
    const ORG = "org-a";
    const db = new FakeDb({
      invoices: [{ id: "1", organization_id: ORG, invoice_ref: "INV-1", customer: "Acme Ltd", job_id: null, total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: "2026-10-20", payment_unverified: false }],
      customers: [{ id: "c1", organization_id: ORG, name: "Acme Ltd", email: "pay@acme.test", contact_name: "Pat" }],
      chase_steps: [{ id: "f7", organization_id: ORG, offset_days: 7, tone: "friendly" }],
      chase_pauses: [], chase_sends: [], jobs: [], purchase_orders: [], email_templates: [],
      organizations: [{ id: ORG, name: "JNR" }], organization_settings: [],
    });
    const createDraft = vi.fn(async (_a: unknown, args: { invoiceId: string }) => ({ created: true as const, history_id: `h-${args.invoiceId}` }));
    const out = await runInvoiceReminders(db as never, { organization_id: ORG, timezone: "Europe/London", recipients: [] } as never, { at: new Date("2026-11-05T08:00:00Z"), periodKey: "2026-11-05" }, new Date("2026-11-05T09:00:00Z"), { createDraft });
    expect(out).toMatchObject({ sent: 0, drafted: 1, failed: 0, error: null });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][1]).toMatchObject({ to: "pay@acme.test", userId: null });
    expect(T.tokenCalls).toBe(0);
  });
});

describe("chase approve: failed and unknown sends, audit rows, explicit Resend", () => {
  const ORG = "org-a", DRAFT = "dr-1", INV = "inv-1";
  let fake: FakeDb; let audit: Array<Record<string, unknown>>; let auditError: boolean; let sent: Array<{ provider?: unknown }>; let result: unknown;
  const deps = (): ApproveDeps => ({
    db: { from: (t: string) => fake.from(t), rpc: async (fn: string, a: Record<string, unknown>) => { if (fn === "write_audit") { audit.push(a); if (auditError) throw new Error("down"); } return { data: null, error: null }; } } as never,
    admin: { from: (t: string) => fake.from(t), rpc: async () => ({ error: null }) } as never,
    provider: async () => ({ name: "microsoft" }), resend: () => ({ name: "resend" }),
    send: async (_i, p) => { sent.push({ provider: p }); return result as never; }, allowlisted: () => false,
  });
  const go = (extra: Record<string, unknown> = {}) => { const d = fake.rows("email_history").find((r) => r.id === DRAFT)!; return approveChaseDraft({ organizationId: ORG, userId: "u", draftId: DRAFT, expectedSubject: String(d.subject), expectedBody: String(d.body), today: "2026-11-05", ...extra } as never, deps()); };
  beforeEach(() => {
    audit = []; auditError = false; sent = []; result = { ok: true, mode: "sent", provider: "microsoft", historyId: "sent-1" };
    fake = new FakeDb({
      email_history: [{ id: DRAFT, organization_id: ORG, to_email: "pay@acme.test", subject: "Reminder INV-1", body: "Please pay", status: "drafted", related_to_type: "invoice", related_to_id: INV }],
      chase_sends: [{ id: "cs1", organization_id: ORG, invoice_id: INV, status: "drafted", draft_history_id: DRAFT }],
      invoices: [{ id: INV, organization_id: ORG, customer: "Acme Ltd", invoice_ref: "INV-1", status: "sent", total: 100, amount_paid: 0, credited_amount: 0, refunded_amount: 0, payment_unverified: false, payment_claimed_at: null }],
      customers: [{ id: "c1", organization_id: ORG, name: "Acme Ltd", email: "pay@acme.test" }], chase_pauses: [], email_schedules: [], user_profiles: [],
    });
  });
  it("a confirmed failure keeps the draft queued and writes an audit row without text or addresses", async () => {
    result = { ok: false, code: "provider_error", error: "refused" };
    expect(await go()).toMatchObject({ status: "refused", http: 502 });
    expect(fake.rows("email_history")[0].status).toBe("drafted");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ p_action: "UPDATE", p_entity_table: "email_history", p_entity_id: DRAFT, p_new: { outcome: "failed" }, p_metadata: { channel: "chase-approve", code: "provider_error" } });
    expect(JSON.stringify(audit)).not.toMatch(/acme\.test|Reminder|Please pay/);
  });
  it("an uncertain send is held, audited, and a lost audit write changes nothing", async () => {
    auditError = true;
    result = { ok: false, code: "provider_error", error: "unsure", uncertain: true };
    expect(await go()).toMatchObject({ status: "refused", http: 502 });
    expect(fake.rows("email_history")[0].status).toBe("unknown");
    expect(audit[0]).toMatchObject({ p_new: { outcome: "unknown" } });
    expect(await go()).toMatchObject({ status: "refused", http: 409 });
    expect(sent).toHaveLength(1);
  });
  it("Resend is used only on an admin's explicit choice for a confirmed failure", async () => {
    expect(await go({ provider: "resend", isAdmin: true })).toMatchObject({ http: 409 }); // not failed yet
    fake.rows("email_history").push({ id: "old", organization_id: ORG, status: "failed", related_to_id: INV });
    expect(await go({ provider: "resend", isAdmin: false })).toMatchObject({ http: 403 });
    expect(sent).toHaveLength(0);
    expect(await go({ provider: "resend", isAdmin: true })).toMatchObject({ status: "sent" });
    expect(sent).toEqual([{ provider: { name: "resend" } }]);
    expect(audit[0]).toMatchObject({ p_new: { outcome: "provider_override", provider: "resend" } });
  });
});
