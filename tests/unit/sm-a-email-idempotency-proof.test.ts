/**
 * Proof for the "required idempotency key" condition.
 *  - With migration 106: the same key sends ONCE (ledger replay), a different key sends again.
 *  - Without 106: app code cannot stop a repeat by itself. What it does guarantee is that every retry carries the SAME
 *    provider idempotency key (Resend honours it; Microsoft Graph has no such header). A caller needing a hard guarantee uses requireLedger.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => null }));

import type { EmailProvider, OutgoingEmail } from "@/lib/email/providers/types";
import { type CompanyEmailInput, sendCompanyEmail } from "@/lib/email/send-company-email";

type Row = Record<string, unknown>;
function db(missing: boolean) {
  const ledger = new Map<string, { id: string; status: string }>();
  return {
    rpc: async (fn: string, a: Row) => {
      if (missing) return { data: null, error: { code: "PGRST202" } };
      if (fn === "reserve_company_email") {
        const k = String(a.p_key);
        const prior = ledger.get(k);
        if (prior) return { data: { send_id: prior.id, history_id: "h", status: prior.status, replay: true }, error: null };
        ledger.set(k, { id: `s${ledger.size}`, status: "sending" });
        return { data: { send_id: ledger.get(k)!.id, history_id: "h", status: "sending", replay: false }, error: null };
      }
      for (const v of ledger.values()) if (v.id === a.p_send) v.status = String(a.p_outcome);
      return { data: null, error: null };
    },
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "h" }, error: null }) }) }),
      update: () => { const c = { eq: () => c, then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r) }; return c; },
    }),
  } as never;
}
function provider() {
  const sent: OutgoingEmail[] = [];
  const p: EmailProvider = { name: "microsoft", send: vi.fn(async (e: OutgoingEmail) => { sent.push(e); return { outcome: "accepted", detail: "x" } as never; }) };
  return { p, sent };
}
const base: CompanyEmailInput = { organizationId: "org-1", userId: "u-1", kind: "invoice", to: ["c@example.test"], subject: "Invoice I-1", text: "Hello", recordType: "invoice", recordId: "rec-1", idempotencyKey: "key-12345678" };

describe("idempotency key", () => {
  it("with 106: the same key sends once; a new key sends again", async () => {
    const d = db(false); const { p } = provider();
    await sendCompanyEmail(base, { db: d, provider: p });
    await sendCompanyEmail(base, { db: d, provider: p });
    expect(p.send).toHaveBeenCalledTimes(1);
    await sendCompanyEmail({ ...base, idempotencyKey: "key-87654321" }, { db: d, provider: p });
    expect(p.send).toHaveBeenCalledTimes(2);
  });
  it("without 106: a retry reaches the provider again, but with the identical provider idempotency key", async () => {
    const d = db(true); const { p, sent } = provider();
    await sendCompanyEmail(base, { db: d, provider: p });
    await sendCompanyEmail(base, { db: d, provider: p });
    expect(p.send).toHaveBeenCalledTimes(2);
    expect(sent[0].idempotencyKey).toMatch(/^company-email\/[0-9a-f]{64}$/);
    expect(sent[1].idempotencyKey).toBe(sent[0].idempotencyKey);
  });
  it("without 106 and requireLedger: nothing is sent", async () => {
    const { p } = provider();
    const out = await sendCompanyEmail({ ...base, requireLedger: true }, { db: db(true), provider: p });
    expect(out).toMatchObject({ ok: false });
    expect(p.send).not.toHaveBeenCalled();
  });
});
