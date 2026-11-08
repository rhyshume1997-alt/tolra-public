/** Approved text through real app routes, mailer, ledger calls and provider adapters.
 * Only authentication/database transport and Microsoft/Resend HTTP delivery are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../support/fake-db";
vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ db: null as unknown, provider: "microsoft", resendSend: vi.fn() }));
vi.mock("@/lib/server/auth", async original => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireProfile: async () => ({ supabase: h.db, user: { id: "office-a" }, profile: { organization_id: "a", role: "office" }, session: { support: false } }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => h.db }));
vi.mock("@/lib/integrations/microsoft/token-source", () => ({ getDelegatedAccessToken: async () => h.provider === "microsoft" ? "synthetic-access-token" : null }));
vi.mock("resend", () => ({ Resend: class { emails = { send: h.resendSend }; } }));
import { POST as documentSend } from "@/app/api/email/send/route";
import { POST as jobSend } from "@/app/api/send-job/route";
import { POST as chaseSend } from "@/app/api/chase/approve/route";
import { GRAPH_SEND_MAIL_URL } from "@/lib/email/providers/microsoft";
const INVOICE = "11111111-1111-4111-8111-111111111111", JOB = "22222222-2222-4222-8222-222222222222", DRAFT = "33333333-3333-4333-8333-333333333333";
const TO = "customer@example.test", SUBJECT = "Invoice INV-1 – £120";
const BODIES = [" \nHello  \n", "Hello\r\n\r\nKeep\t spaces.\r\n", "Hi <John> & café — £120 👋\n"];
let db: FakeDb & { rpc: ReturnType<typeof vi.fn> }, graph: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("EMAIL_PROVIDER", ""); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("RESEND_API_KEY", "re_fake_wire_only"); vi.stubEnv("EMAIL_FROM", "office@example.test");
  h.resendSend.mockReset().mockResolvedValue({ data: { id: "msg_mock" }, error: null });
  graph = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal("fetch", graph);
  db = Object.assign(new FakeDb({
    invoices: [{ id: INVOICE, organization_id: "a", invoice_ref: "INV-1", customer: "Customer", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent" }],
    jobs: [{ id: JOB, organization_id: "a", customer: "Customer", customer_email: TO }],
    customers: [{ id: "customer", organization_id: "a", name: "Customer", email: TO }],
    email_history: [{ id: DRAFT, organization_id: "a", to_email: TO, subject: SUBJECT, body: "set by case", status: "drafted", related_to_type: "invoice", related_to_id: INVOICE }],
    chase_sends: [{ organization_id: "a", draft_history_id: DRAFT, invoice_id: INVOICE, status: "drafted" }],
    chase_pauses: [], email_schedules: [], user_profiles: [],
  }), { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "reserve_company_email") return { data: { send_id: "send", history_id: "sent-history", status: "sending", replay: false }, error: null };
    if (name === "reserve_job_email") return { data: { history_id: "sent-history", status: "sending", replay: false }, error: null };
    if (name === "chase_record_sent") return { data: { recorded: true }, error: null };
    void args; return { data: null, error: null };
  }) });
  h.db = db;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const request = (route: string, body: object) => new Request(`https://app.test${route}`, { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body) });
const paths = [
  { name: "document", run: (text: string) => documentSend(request("/api/email/send", { kind: "invoice", record_id: INVOICE, to: [TO], subject: SUBJECT, text, idempotency_key: "wire-document-0001" })) },
  { name: "job", run: (body: string) => jobSend(request("/api/send-job", { job_id: JOB, recipient_email: TO, subject: SUBJECT, body, idempotency_key: "wire-job-0001" })) },
  { name: "chase", run: (body: string) => { db.rows("email_history")[0].body = body; return chaseSend(request("/api/chase/approve", { history_id: DRAFT, expected_to: TO, expected_subject: SUBJECT, expected_body: body })); } },
];
describe.each(["microsoft", "resend"])("%s wire payload", provider => {
  describe.each(paths)("$name approval", path => {
    it.each(BODIES)("sends the exact reviewed text: %j", async body => {
      h.provider = provider;
      const response = await path.run(body);
      expect(response.status, JSON.stringify(await response.json())).toBe(200);
      if (provider === "microsoft") {
        expect(graph).toHaveBeenCalledTimes(1); expect(graph.mock.calls[0][0]).toBe(GRAPH_SEND_MAIL_URL);
        const payload = JSON.parse(String(graph.mock.calls[0][1]?.body));
        expect(payload.message.subject).toBe(SUBJECT);
        expect(payload.message.body).toEqual({ contentType: "Text", content: body });
        expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: TO } }]);
        expect(h.resendSend).not.toHaveBeenCalled();
      } else {
        expect(h.resendSend).toHaveBeenCalledTimes(1);
        expect(h.resendSend.mock.calls[0][0]).toMatchObject({ to: [TO], subject: SUBJECT, text: body });
        expect(h.resendSend.mock.calls[0][0].html).toBeUndefined();
        expect(graph).not.toHaveBeenCalled();
      }
      const reserved = db.rpc.mock.calls.find(c => ["reserve_company_email", "reserve_job_email"].includes(String(c[0])))!;
      expect(reserved[1]).toMatchObject({ p_subject: SUBJECT, p_body: body });
    });
  });
});
