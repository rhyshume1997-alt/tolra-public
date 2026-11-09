/** App approval route + browser request builder + real chase guard, with only database/auth transport and mail delivery mocked. */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../support/fake-db";
import type { CompanyEmailResult } from "@/lib/email/send-company-email";
vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ db: null as unknown, role: "office", support: false, send: vi.fn(), provider: vi.fn(), resend: vi.fn() }));
vi.mock("@/lib/server/auth", async original => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireProfile: async (roles: string[]) => roles.includes(h.role) ? { supabase: h.db, user: { id: "reviewer-a" }, profile: { organization_id: "a", role: h.role }, session: { support: h.support } } : NextResponse.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => h.db }));
vi.mock("@/lib/email/send-company-email", async original => ({
  ...(await original<typeof import("@/lib/email/send-company-email")>()),
  sendCompanyEmail: (...args: unknown[]) => h.send(...args), selectProvider: (...args: unknown[]) => h.provider(...args), resendFromEnv: h.resend,
}));
import { POST } from "@/app/api/chase/approve/route";
import { approveDraft } from "@/lib/chase/ui-store";
const ID = "11111111-1111-4111-8111-111111111111";
const reviewed = { to: "customer@example.test", subject: "Invoice INV-1", body: "Hello,\n\nPlease check invoice INV-1.\n" };
let db: FakeDb & { rpc: ReturnType<typeof vi.fn> };
const call = (body: object) => POST(new Request("https://app.test/api/chase/approve", { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body) }));
const request: typeof fetch = async (_input, init) => call(JSON.parse(String(init?.body)));
const approve = () => approveDraft(ID, reviewed, request);
const snapshot = () => ({ history_id: ID, expected_to: reviewed.to, expected_subject: reviewed.subject, expected_body: reviewed.body });
beforeEach(() => {
  h.role = "office"; h.support = false;
  h.send.mockReset().mockResolvedValue({ ok: true, mode: "sent", provider: "mock", historyId: "sent-a" });
  h.provider.mockReset().mockResolvedValue({ name: "mock" }); h.resend.mockReset();
  db = Object.assign(new FakeDb({
    email_history: [{ id: ID, organization_id: "a", to_email: reviewed.to, subject: reviewed.subject, body: reviewed.body, status: "drafted", related_to_type: "invoice", related_to_id: "invoice-a" }],
    chase_sends: [{ organization_id: "a", draft_history_id: ID, invoice_id: "invoice-a", status: "drafted" }],
    invoices: [{ id: "invoice-a", organization_id: "a", customer: "Customer A", invoice_ref: "INV-1", status: "sent", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0 }],
    customers: [{ id: "customer-a", organization_id: "a", name: "Customer A", email: reviewed.to }],
    user_profiles: [{ organization_id: "a", email: "office@example.test" }], chase_pauses: [], email_schedules: [],
  }), { rpc: vi.fn().mockResolvedValue({ data: { recorded: true }, error: null }) });
  h.db = db;
});
describe("reviewed approval crosses the real app route", () => {
  it("the browser's displayed recipient, subject and body are exactly handed to the mailer", async () => {
    await expect(approve()).resolves.toMatchObject({ status: "sent", recorded: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({ organizationId: "a", userId: "reviewer-a", to: [reviewed.to], subject: reviewed.subject, text: reviewed.body });
    expect(h.send.mock.calls[0][1]).toMatchObject({ provider: { name: "mock" } });
    expect(db.rpc).toHaveBeenCalledWith("chase_record_sent", expect.objectContaining({ p_org: "a", p_user: "reviewer-a" }));
  });
  it.each(["to_email", "subject", "body"])("rejects an edit to %s after the screen was loaded", async field => {
    db.rows("email_history")[0][field] = field === "to_email" ? "office@example.test" : "Changed elsewhere";
    await expect(approve()).rejects.toThrow(/changed/);
    expect(h.send).not.toHaveBeenCalled(); expect(h.provider).not.toHaveBeenCalled();
  });
  it("an old client without a reviewed recipient cannot approve", async () => {
    const { expected_to, ...withoutTo } = snapshot(); void expected_to;
    expect((await call(withoutTo)).status).toBe(400); expect(h.send).not.toHaveBeenCalled();
  });
  it("a caller cannot nominate a different company in the request", async () => {
    expect((await call({ ...snapshot(), organization_id: "b" })).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled(); expect(h.provider).not.toHaveBeenCalled();
  });
  it("a different company's draft ID is refused before provider selection", async () => {
    db.rows("email_history")[0].organization_id = "b";
    expect((await call(snapshot())).status).toBe(404); expect(h.provider).not.toHaveBeenCalled();
  });
  it.each(["paid", "credited", "void", "written_off"])("a %s invoice is never sent", async status => {
    db.rows("invoices")[0].status = status;
    expect((await call(snapshot())).status).toBe(409); expect(h.send).not.toHaveBeenCalled();
  });
  it.each(["Checking a payment", "Customer disputes the invoice"])("a paused/disputed invoice is never sent: %s", async reason => {
    db.rows("chase_pauses").push({ id: "pause", organization_id: "a", invoice_id: "invoice-a", customer_id: null, paused_until: null, reason });
    expect((await call(snapshot())).status).toBe(409); expect(h.send).not.toHaveBeenCalled();
  });
  it("overlapping requests deliver only once", async () => {
    const result = await Promise.all([call(snapshot()), call(snapshot())]);
    expect(result.filter(r => r.status === 200)).toHaveLength(1); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it("an unknown result holds the draft and prevents every further attempt, including an explicit Resend choice", async () => {
    h.send.mockResolvedValue({ ok: false, code: "provider_error", error: "Connection lost", uncertain: true } satisfies CompanyEmailResult);
    expect((await call(snapshot())).status).toBe(502);
    h.role = "admin";
    expect((await call(snapshot())).status).toBe(409);
    expect((await call({ ...snapshot(), provider: "resend" })).status).toBe(409);
    expect(db.rows("email_history")[0].status).toBe("unknown");
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.resend).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledWith("write_audit", expect.objectContaining({ p_new: { outcome: "unknown" } }));
  });
  it("a broken Microsoft connection is not permission for Resend", async () => {
    h.provider.mockRejectedValue(new Error("invalid_grant"));
    expect((await call(snapshot())).status).toBe(502);
    expect(h.send).not.toHaveBeenCalled(); expect(h.resend).not.toHaveBeenCalled();
    expect(db.rows("email_history")[0].status).toBe("drafted");
  });
  it.each(["workshop", "read_only", "support"])("a %s session cannot send", async role => {
    h.role = role === "support" ? "admin" : role; h.support = role === "support";
    expect((await call(snapshot())).status).toBe(403); expect(h.send).not.toHaveBeenCalled();
  });
});
