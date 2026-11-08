/**
 * Branch D (state-machine review): every path by which one e-mail could go out twice, proved or shown blocked.
 *   - sendCompanyEmail with no idempotency key (a fresh random key per call): a retry is a new e-mail. The ROUTE is where this is closed
 *     (sm-d-email-route-key.test.ts); the library stays as is for its internal callers, which all pass a key.
 *   - the pre-106 fallback (no ledger): no replay guard of its own. Only reachable while migration 106 is absent.
 *   - the timesheet job releasing its claim when a send is uncertain: blocked by the ledger (same key => replay, never a second send).
 *   - the chase approval when chase_record_sent fails: the mail is sent once, the draft stays claimed ('sending'), a second approval is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => null }));

import { approveChaseDraft } from "@/lib/email/chase/approve";
import { scheduleEmailKey } from "@/lib/email/schedules/keys";
import { dueOccurrence } from "@/lib/email/schedules/due";
import type { EmailScheduleRow } from "@/lib/email/schedules/store";
import { runTimesheets } from "@/lib/email/schedules/timesheet";
import type { EmailProvider, OutgoingEmail, ProviderResult } from "@/lib/email/providers/types";
import { type CompanyEmailInput, sendCompanyEmail } from "@/lib/email/send-company-email";
import { DEFAULT_TIME_SETTINGS } from "@/lib/time-sheet";
import { FakeDb } from "../support/fake-db";

type Row = Record<string, unknown>;

/** reserve_company_email / complete_company_email as 106 behaves: a key seen before is a replay unless it failed. `missing` = before 106. */
function ledgerDb(opts: { missing?: boolean } = {}) {
  const ledger: Array<{ id: string; key: string; history: string; status: string }> = [];
  const db = {
    rpc: async (fn: string, args: Row) => {
      if (opts.missing) return { data: null, error: { code: "PGRST202" } };
      if (fn === "reserve_company_email") {
        const prior = ledger.find((l) => l.key === args.p_key);
        if (prior && prior.status !== "failed") return { data: { send_id: prior.id, history_id: prior.history, status: prior.status, replay: true }, error: null };
        if (prior) { prior.status = String(args.p_mode); return { data: { send_id: prior.id, history_id: prior.history, status: prior.status, replay: false }, error: null }; }
        const row = { id: `s-${ledger.length + 1}`, key: String(args.p_key), history: `h-${ledger.length + 1}`, status: String(args.p_mode) };
        ledger.push(row);
        return { data: { send_id: row.id, history_id: row.history, status: row.status, replay: false }, error: null };
      }
      if (fn === "complete_company_email") {
        const row = ledger.find((l) => l.id === args.p_send && l.status === "sending");
        if (!row) return { data: null, error: { code: "P0002" } };
        row.status = String(args.p_outcome);
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "h-direct" }, error: null }) }) }),
      update: () => { const chain = { eq: () => chain, then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r) }; return chain; },
    }),
  };
  return db as never;
}

function provider(outcome: ProviderResult["outcome"] = "accepted") {
  const sent: OutgoingEmail[] = [];
  const p: EmailProvider = { name: "microsoft", send: vi.fn(async (e: OutgoingEmail) => { sent.push(e); return { outcome, detail: "x" } as ProviderResult; }) };
  return { p, sent };
}

const base: CompanyEmailInput = { organizationId: "org-1", userId: "u-1", kind: "invoice", to: ["c@example.test"], subject: "Invoice I-1", text: "Hello", recordType: "invoice", recordId: "rec-1" };

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });

describe("send with no idempotency key", () => {
  it("a retry is a NEW e-mail: two calls, two provider sends (why the route must require a key)", async () => {
    const db = ledgerDb();
    const { p } = provider();
    await sendCompanyEmail(base, { db, provider: p });
    await sendCompanyEmail(base, { db, provider: p });
    expect(p.send).toHaveBeenCalledTimes(2);
  });
  it("with the same key the second call is a replay: one provider send", async () => {
    const db = ledgerDb();
    const { p } = provider();
    const a = await sendCompanyEmail({ ...base, idempotencyKey: "key-12345678" }, { db, provider: p });
    const b = await sendCompanyEmail({ ...base, idempotencyKey: "key-12345678" }, { db, provider: p });
    expect(a).toMatchObject({ ok: true, mode: "sent" });
    expect(b).toMatchObject({ ok: true, mode: "sent" });
    expect(p.send).toHaveBeenCalledTimes(1);
  });
});

describe("the pre-106 fallback (reserve_company_email absent)", () => {
  it("has no replay guard of its own: the same key sends twice (only reachable while 106 is not applied)", async () => {
    const db = ledgerDb({ missing: true });
    const { p } = provider();
    await sendCompanyEmail({ ...base, idempotencyKey: "key-12345678" }, { db, provider: p });
    await sendCompanyEmail({ ...base, idempotencyKey: "key-12345678" }, { db, provider: p });
    expect(p.send).toHaveBeenCalledTimes(2);
  });
  it("a caller that needs the ledger (requireLedger) sends nothing instead", async () => {
    const db = ledgerDb({ missing: true });
    const { p } = provider();
    const out = await sendCompanyEmail({ ...base, idempotencyKey: "key-12345678", requireLedger: true }, { db, provider: p });
    expect(out).toMatchObject({ ok: false });
    expect(p.send).not.toHaveBeenCalled();
  });
});

describe("timesheet job: an uncertain send gives the claim back", () => {
  const ORG = "org-a";
  const A = "user-a";
  vi.mock("@/lib/time-data", async (original) => ({
    ...(await original<typeof import("@/lib/time-data")>()),
    loadTimeData: async () => ({ events: [
      { id: "e1", user_id: "user-a", action: "in", at: "2026-10-19T07:00:00Z", source: "clock" },
      { id: "e2", user_id: "user-a", action: "out", at: "2026-10-19T15:30:00Z", source: "clock" },
    ], labour: [], settings: { ...DEFAULT_TIME_SETTINGS }, bankHolidays: new Map(), jobs: {} }),
  }));
  const schedule: EmailScheduleRow = {
    id: "sch-2", organization_id: ORG, kind: "timesheet", enabled: true, frequency: "weekly", weekday: 1, time_of_day: "09:00", run_at: null,
    timezone: "Europe/London", recipients: ["boss@jnr.test"], last_run_at: null, updated_at: "2026-10-01T00:00:00Z",
  };
  const now = new Date("2026-10-26T09:05:00Z");
  const occurrence = dueOccurrence(schedule, now)!;
  const admin = () => new FakeDb({ user_profiles: [{ id: A, email: "a@jnr.test", full_name: "Alex" }], organizations: [{ id: ORG, name: "JNR" }] });

  it("with the ledger: the uncertain send is retried as a replay, never sent a second time", async () => {
    const db = ledgerDb();
    const { p } = provider("unknown");
    const send = (input: CompanyEmailInput) => sendCompanyEmail(input, { db, provider: p });
    const a = admin();
    const first = await runTimesheets(a as never, schedule, occurrence, now, { send });
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    expect(a.rows("timesheet_sends")).toEqual([]); // the claim was given back
    const second = await runTimesheets(a as never, schedule, occurrence, now, { send });
    expect(second).toMatchObject({ sent: 0, failed: 1 });
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(scheduleEmailKey("timesheet", "sch-2", occurrence.periodKey, A)).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });
  it("without the ledger (106 absent) the retry would send again", async () => {
    const db = ledgerDb({ missing: true });
    const { p } = provider("unknown");
    const send = (input: CompanyEmailInput) => sendCompanyEmail(input, { db, provider: p });
    const a = admin();
    await runTimesheets(a as never, schedule, occurrence, now, { send });
    await runTimesheets(a as never, schedule, occurrence, now, { send });
    expect(p.send).toHaveBeenCalledTimes(2);
  });
});

describe("chase approval when the sent record cannot be written", () => {
  const ORG = "org-a";
  const DRAFT = "11111111-1111-4111-8111-111111111111";
  it("sends once, leaves the draft claimed, and a second approval is refused without sending", async () => {
    const db = new FakeDb({
      email_history: [{ id: DRAFT, organization_id: ORG, to_email: "pay@acme.test", subject: "Overdue invoice INV-1", body: "Hi Acme Ltd\n\nPlease pay", status: "drafted", related_to_type: "invoice", related_to_id: "inv-1" }],
      chase_sends: [{ id: "cs-1", organization_id: ORG, invoice_id: "inv-1", status: "drafted", draft_history_id: DRAFT }],
      invoices: [{ id: "inv-1", organization_id: ORG, customer: "Acme Ltd", invoice_ref: "INV-1", status: "sent", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, payment_unverified: false }],
      customers: [{ id: "c1", organization_id: ORG, name: "Acme Ltd", email: "pay@acme.test" }],
      chase_pauses: [], email_schedules: [], user_profiles: [],
    });
    const admin = Object.assign(new FakeDb({ email_history: [] }), { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "XX000" } }) });
    const send = vi.fn(async () => ({ ok: true as const, mode: "sent" as const, provider: "mock" as const, historyId: "sent-1" }));
    const approve = () => approveChaseDraft(
      { organizationId: ORG, userId: "u-office", draftId: DRAFT, today: "2026-11-13", expectedTo: "pay@acme.test", expectedSubject: "Overdue invoice INV-1", expectedBody: "Hi Acme Ltd\n\nPlease pay" },
      { db: db as never, admin: admin as never, provider: async () => ({ name: "mock" }), send, allowlisted: () => false },
    );
    expect(await approve()).toMatchObject({ status: "sent", recorded: false });
    expect(db.rows("email_history")[0]).toMatchObject({ status: "sending" });
    expect(await approve()).toMatchObject({ status: "refused", http: 409 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
