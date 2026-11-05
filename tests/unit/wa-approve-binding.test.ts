/* eslint-disable @typescript-eslint/no-explicit-any */
// Worker W-A: approved e-mail binding and failure handling (approveDraft, chase approve, no automatic provider switch, audit rows).
// Mocks only: no provider, no database, no network.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { approveDraft, type DraftApprovalDeps } from "@/lib/email/approve-draft";
import { customerStatement } from "@/lib/email/customer-statement";
import type { CompanyEmailResult } from "@/lib/email/send-company-email";
import { FakeDb } from "../support/fake-db";

const ORG = "org-a", CUST = "11111111-1111-4111-8111-111111111111", DRAFT = "d-1", USER = "u-1";
let fake: FakeDb;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
let auditMode: "ok" | "error" | "throw";
let hookAfterClaim: (() => void) | null;
let sends: Array<{ to: string[]; subject: string; text: string; provider: string }>;
let answer: CompanyEmailResult | "throw";
let providerCalls: number, resendCalls: number, providerThrows: boolean, resendConfigured: boolean;

// FakeDb has no ilike (E2/E1 files are not edited): add the one the statement code uses, here only.
const proto = Object.getPrototypeOf(new FakeDb().from("x")) as Record<string, any>;
proto.ilike ??= function (this: { filters: Array<(r: Record<string, unknown>) => boolean> }, col: string, v: string) {
  const want = v.replace(/\\(.)/g, "$1").toLowerCase();
  this.filters.push((r) => String(r[col]).toLowerCase() === want);
  return this;
};
const db = {
  from(table: string) {
    const q = fake.from(table) as unknown as Record<string, any>;
    if (table === "email_history") {
      const update = q.update.bind(q);
      q.update = (patch: Record<string, unknown>) => {
        const u = update(patch);
        if (patch.status === "sending" && hookAfterClaim) {
          const then = u.then.bind(u);
          u.then = (ok: any, bad: any) => then((r: unknown) => { hookAfterClaim?.(); hookAfterClaim = null; return r; }).then(ok, bad);
        }
        return u;
      };
    }
    return q;
  },
  async rpc(fn: string, args: Record<string, unknown>) {
    rpcCalls.push({ fn, args });
    if (fn === "customer_credit") return { data: [], error: null };
    if (fn === "write_audit") { if (auditMode === "throw") throw new Error("audit down"); return { data: null, error: auditMode === "error" ? { code: "42501" } : null }; }
    throw new Error(`unexpected rpc ${fn}`);
  },
};
const deps = (): DraftApprovalDeps => ({
  db: db as never,
  provider: async () => { providerCalls += 1; if (providerThrows) throw new Error("token lookup failed"); return { name: "microsoft", send: async () => ({ outcome: "accepted", detail: "" }) } as never; },
  resend: async () => { resendCalls += 1; return resendConfigured ? ({ name: "resend", send: async () => ({ outcome: "accepted", detail: "" }) } as never) : null; },
  send: async (mail, provider) => {
    sends.push({ to: mail.to, subject: mail.subject, text: mail.text, provider: provider.name });
    if (answer === "throw") throw new Error("connection reset");
    return answer;
  },
});
const history = () => fake.rows("email_history").find((r) => r.id === DRAFT)!;
const approve = (extra: Record<string, unknown> = {}) => { const r = history(); return approveDraft({ org: ORG, user: USER, draftId: DRAFT, subject: String(r.subject), body: String(r.body), to: String(r.to_email), ...extra } as never, deps()); };
const auditRows = () => rpcCalls.filter((c) => c.fn === "write_audit").map((c) => c.args);

beforeEach(async () => {
  rpcCalls = []; auditMode = "ok"; hookAfterClaim = null; sends = []; providerCalls = 0; resendCalls = 0; providerThrows = false; resendConfigured = true;
  answer = { ok: true, mode: "sent", provider: "microsoft", historyId: "sent-1" };
  fake = new FakeDb({ customers: [{ id: CUST, organization_id: ORG, name: "Practice Customer", email: "buyer@customer.test" }], invoices: [], email_history: [] });
  const s = await customerStatement(db as never, ORG, CUST, "2026-11-05");
  fake.rows("email_history").push({ id: DRAFT, organization_id: ORG, to_email: s.to, subject: s.subject, body: s.text, status: "drafted", related_to_type: "general", related_to_id: s.recordId, drafted_by: USER });
});

describe("approved recipient, subject and body are exactly what is sent", () => {
  it("never uses a recipient from the request: a different `to` voids the approval and nothing is sent", async () => {
    const out = await approve({ to: "attacker@evil.test" });
    expect(out.status).toBe(409);
    expect(sends).toEqual([]);
  });
  it("sends exactly the stored recipient, subject and body", async () => {
    const r = history();
    expect((await approve()).status).toBe(200);
    expect(sends).toEqual([{ to: ["buyer@customer.test"], subject: r.subject, text: r.body, provider: "microsoft" }]);
  });
  it("a customer e-mail changed after the draft is not followed: nothing is sent to the old or the new address", async () => {
    fake.rows("customers")[0].email = "new@customer.test";
    expect((await approve()).status).toBe(409);
    expect(sends).toEqual([]);
  });
  it("an edit that lands after the claim voids the approval: nothing is sent, the draft is back for review, an audit row says so", async () => {
    hookAfterClaim = () => { history().body = `${history().body} (edited)`; };
    const out = await approve();
    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/changed after you approved/);
    expect(sends).toEqual([]);
    expect(history().status).toBe("drafted");
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ p_action: "UPDATE", p_entity_table: "email_history", p_entity_id: DRAFT, p_new: { outcome: "changed" } });
  });
  it("a recipient changed after the claim also voids it", async () => {
    hookAfterClaim = () => { history().to_email = "redirected@evil.test"; };
    expect((await approve()).status).toBe(409);
    expect(sends).toEqual([]);
  });
});

describe("failed and unknown sends leave an audit row and keep the right state", () => {
  it("a confirmed failure: the draft stays queued for approval, a clear error, one audit row with ids and codes only", async () => {
    answer = { ok: false, code: "provider_error", error: "The e-mail service refused this e-mail. Check the addresses and try again." };
    const out = await approve();
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/refused/);
    expect(history().status).toBe("drafted");
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ p_action: "UPDATE", p_entity_table: "email_history", p_entity_id: DRAFT, p_new: { outcome: "failed", provider: "microsoft" }, p_metadata: { channel: "email-approve", code: "provider_error" } });
    const text = JSON.stringify(rows);
    expect(text).not.toContain("buyer@customer.test");
    expect(text).not.toContain(String(history().subject));
    expect(text).not.toContain("Customer statement as at");
  });
  it("an uncertain send: held as unknown, an audit row, never retried or sent another way", async () => {
    answer = { ok: false, code: "provider_error", error: "We couldn't confirm", uncertain: true };
    expect((await approve()).status).toBe(502);
    expect(history().status).toBe("unknown");
    expect(auditRows()[0]).toMatchObject({ p_new: { outcome: "unknown" } });
    const again = await approve();
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/not known yet/);
    const viaResend = await approve({ provider: "resend", isAdmin: true });
    expect(viaResend.status).toBe(409);
    expect(sends).toHaveLength(1);
  });
  it("a thrown send is unknown too", async () => {
    answer = "throw";
    expect((await approve()).status).toBe(502);
    expect(history().status).toBe("unknown");
    expect(auditRows()[0]).toMatchObject({ p_new: { outcome: "unknown" } });
  });
  for (const mode of ["error", "throw"] as const) {
    it(`a failed audit write (${mode}) never turns an uncertain send into a retryable one or sends twice`, async () => {
      auditMode = mode;
      answer = { ok: false, code: "provider_error", error: "We couldn't confirm", uncertain: true };
      const out = await approve();
      expect(out.status).toBe(502);
      expect(history().status).toBe("unknown");
      expect(sends).toHaveLength(1);
      expect((await approve()).status).toBe(409);
      expect(sends).toHaveLength(1);
    });
  }
  it("a successful send writes no failure audit row", async () => {
    expect((await approve()).status).toBe(200);
    expect(auditRows()).toEqual([]);
  });
});

describe("no automatic provider switch; an admin may pick Resend for one confirmed failure", () => {
  it("Microsoft token lookup failing: 502, nothing sent, Resend never consulted, draft intact", async () => {
    providerThrows = true;
    const out = await approve();
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/no other provider was used/);
    expect(resendCalls).toBe(0);
    expect(sends).toEqual([]);
    expect(history().status).toBe("drafted");
  });
  it("an explicit Resend choice needs an admin", async () => {
    fake.rows("email_history").push({ id: "old", organization_id: ORG, status: "failed", related_to_id: history().related_to_id });
    expect((await approve({ provider: "resend", isAdmin: false })).status).toBe(403);
    expect(sends).toEqual([]);
  });
  it("is refused for a message that has not failed", async () => {
    expect((await approve({ provider: "resend", isAdmin: true })).status).toBe(409);
    expect(sends).toEqual([]);
  });
  it("is refused when an earlier attempt's outcome is unknown", async () => {
    fake.rows("email_history").push({ id: "o1", organization_id: ORG, status: "failed", related_to_id: history().related_to_id }, { id: "o2", organization_id: ORG, status: "unknown", related_to_id: history().related_to_id });
    expect((await approve({ provider: "resend", isAdmin: true })).status).toBe(409);
    expect(sends).toEqual([]);
  });
  it("is refused when Resend is not configured", async () => {
    resendConfigured = false;
    fake.rows("email_history").push({ id: "old", organization_id: ORG, status: "failed", related_to_id: history().related_to_id });
    expect((await approve({ provider: "resend", isAdmin: true })).status).toBe(503);
    expect(sends).toEqual([]);
  });
  it("a confirmed failure: the admin's Resend choice sends that one message through Resend, once, and is audited", async () => {
    fake.rows("email_history").push({ id: "old", organization_id: ORG, status: "failed", related_to_id: history().related_to_id });
    const r = history();
    const out = await approve({ provider: "resend", isAdmin: true });
    expect(out.status).toBe(200);
    expect(sends).toEqual([{ to: ["buyer@customer.test"], subject: r.subject, text: r.body, provider: "resend" }]);
    expect(providerCalls).toBe(0);
    expect(auditRows()[0]).toMatchObject({ p_new: { outcome: "provider_override", provider: "resend" } });
    expect(fake.rows("email_history").find((x) => x.id === DRAFT)).toBeUndefined();
  });
});
