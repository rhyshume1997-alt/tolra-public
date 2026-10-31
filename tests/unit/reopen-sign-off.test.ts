/**
 * Reopen sign-off (migration 113; Rhys 30 Oct, D30-5), the app side:
 *   - the dialog's state machine: reason 10..500 characters, the confirmation ticked, then an admin's own approval or (anyone else)
 *     a choice of "An admin is here" or the "No admin available" tick box; a job reopen_job would refuse can't be submitted;
 *   - the confirmation sentence names the job and its invoice (an issued invoice stays as it is; a draft stays a draft); an invoiced job
 *     is offered the sign-off (113 reopens it past the invoice), a job gone out is refused;
 *   - the RPC call shapes (reopen_preview, reopen_record, decide_reopen_request; reopen_job in fallback);
 *   - fallback while 113 isn't applied: today's Reopen and the notice "Admin approval recording is available after database update 113";
 *   - the Approval Queue's list (badges, "does not undo", buttons for an admin only) and the dialog's content as rendered;
 *   - the notify route: only the requester, for a fresh pending request of their company; the admins' addresses, the mailer contract.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: "admin" }) }));

import { ReopenApprovalsList } from "@/components/reopen-approvals";
import { ReopenFormBody, type ReopenFormBodyProps } from "@/components/reopen-job-dialog";
import {
  REOPEN_FALLBACK_NOTICE, type ReopenPreview, approvalLine, checkReopenForm, confirmationSentence, decideReopen, loadReopenPreview,
  parsePreview, sendLegacyReopen, sendReopen, submitLabel,
} from "@/lib/reopen-sign-off";

const JOB = { id: "11111111-1111-4111-8111-111111111111", job_no: "J-0012" };
const preview = (over: Partial<ReopenPreview> = {}): ReopenPreview => ({
  record_ref: "J-0012", issued_invoices: [], draft_invoice: false, delivery_notes_out: [], is_admin: false, waiting_request_id: null,
  allowed: true, refusal: null, refusal_hint: null, ...over,
});
const REASON = "Finished by mistake, still machining";

function client(answer: { data?: unknown; error?: unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return { calls, rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: answer.data ?? null, error: (answer.error ?? null) as never }; } };
}

describe("the dialog's state machine", () => {
  const ctx = { isAdmin: false, fallback: false, preview: preview() };
  it("asks for a reason of 10 to 500 characters first (trimmed)", () => {
    expect(checkReopenForm({ reason: "  123456789  ", confirmed: true, mode: "tick_box_notify" }, ctx)).toEqual({ ok: false, error: "Say why it is reopened (at least 10 characters)." });
    expect(checkReopenForm({ reason: "1234567890", confirmed: true, mode: "tick_box_notify" }, ctx)).toEqual({ ok: true, mode: "tick_box_notify" });
    expect(checkReopenForm({ reason: "x".repeat(501), confirmed: true, mode: "tick_box_notify" }, ctx)).toMatchObject({ ok: false, error: "Keep the reason to 500 characters." });
  });
  it("then the confirmation, then (not an admin) a sign-off choice", () => {
    expect(checkReopenForm({ reason: REASON, confirmed: false, mode: "admin_present" }, ctx)).toEqual({ ok: false, error: "Tick the confirmation first." });
    expect(checkReopenForm({ reason: REASON, confirmed: true, mode: null }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining("Choose who signs it off") });
    expect(checkReopenForm({ reason: REASON, confirmed: true, mode: "admin_present" }, ctx)).toEqual({ ok: true, mode: "admin_present" });
    expect(checkReopenForm({ reason: REASON, confirmed: true, mode: "tick_box_notify" }, ctx)).toEqual({ ok: true, mode: "tick_box_notify" });
  });
  it("an admin approves now: always admin_present, never the tick box", () => {
    expect(checkReopenForm({ reason: REASON, confirmed: true, mode: null }, { ...ctx, isAdmin: true })).toEqual({ ok: true, mode: "admin_present" });
    expect(checkReopenForm({ reason: REASON, confirmed: true, mode: "tick_box_notify" }, { ...ctx, isAdmin: true })).toEqual({ ok: true, mode: "admin_present" });
    expect(checkReopenForm({ reason: REASON, confirmed: false, mode: null }, { ...ctx, isAdmin: true })).toMatchObject({ ok: false });
  });
  it("a job the server would refuse can't be submitted; its own reason is shown", () => {
    const refused = preview({ allowed: false, refusal: "J-0012 has gone out (DN-0004), so it can't be reopened." });
    expect(checkReopenForm({ reason: REASON, confirmed: true, mode: "tick_box_notify" }, { ...ctx, preview: refused })).toEqual({ ok: false, error: refused.refusal });
  });
  it("in fallback (no 113) only the reason is asked, as before", () => {
    expect(checkReopenForm({ reason: REASON, confirmed: false, mode: null }, { isAdmin: false, fallback: true, preview: null })).toEqual({ ok: true, mode: null });
    expect(checkReopenForm({ reason: "short", confirmed: false, mode: null }, { isAdmin: false, fallback: true, preview: null })).toMatchObject({ ok: false });
  });
  it("labels the button for the choice made", () => {
    expect(submitLabel({ isAdmin: true, fallback: false, mode: null })).toBe("Approve and reopen");
    expect(submitLabel({ isAdmin: false, fallback: false, mode: "admin_present" })).toBe("Ask the admin to approve");
    expect(submitLabel({ isAdmin: false, fallback: false, mode: "tick_box_notify" })).toBe("Reopen now and notify the admin");
    expect(submitLabel({ isAdmin: false, fallback: true, mode: null })).toBe("Reopen job");
  });
});

describe("the confirmation sentence", () => {
  it("names the job and the issued invoice, which stays as it is", () => {
    expect(confirmationSentence(preview({ issued_invoices: ["INV-0010"] }))).toBe("I am reopening J-0012; the issued invoice INV-0010 stays as it is.");
    expect(confirmationSentence(preview({ issued_invoices: ["INV-0010", "INV-0011"] }))).toBe("I am reopening J-0012; the issued invoices INV-0010, INV-0011 stay as they are.");
  });
  it("a draft invoice stays a draft; no invoice is said too", () => {
    expect(confirmationSentence(preview({ draft_invoice: true }))).toBe("I am reopening J-0012; its draft invoice stays a draft and is not issued.");
    expect(confirmationSentence(preview())).toBe("I am reopening J-0012; it has no issued invoice.");
  });
});

describe("the RPC calls", () => {
  it("preview: reopen_preview with the record type and id; a missing function is the fallback; a partial answer is never 'allowed'", async () => {
    const ok = client({ data: { record_ref: "J-0012", allowed: true, is_admin: true, issued_invoices: [], draft_invoice: true } });
    expect(await loadReopenPreview(ok, JOB)).toMatchObject({ kind: "ready", preview: { allowed: true, is_admin: true, draft_invoice: true } });
    expect(ok.calls).toEqual([{ fn: "reopen_preview", args: { p_record_type: "job", p_record_id: JOB.id } }]);
    expect(await loadReopenPreview(client({ error: { code: "PGRST202", message: "Could not find the function public.reopen_preview" } }), JOB)).toEqual({ kind: "fallback" });
    expect(await loadReopenPreview(client({ error: { code: "42501", message: "not authorised" } }), JOB)).toMatchObject({ kind: "error" });
    expect(parsePreview({}, "J-9")).toMatchObject({ record_ref: "J-9", allowed: false, is_admin: false, issued_invoices: [] });
  });
  it("reopen: reopen_record with type, id, the trimmed reason and the mode", async () => {
    const c = client({ data: { request_id: "r1", status: "pending", reopened: true } });
    const sent = await sendReopen(c, JOB, `  ${REASON}  `, "tick_box_notify");
    expect(c.calls).toEqual([{ fn: "reopen_record", args: { p_record_type: "job", p_record_id: JOB.id, p_reason: REASON, p_mode: "tick_box_notify" } }]);
    expect(sent).toMatchObject({ ok: true, status: "pending", reopened: true, requestId: "r1", message: expect.stringContaining("The admin has been told") });
    expect(await sendReopen(client({ data: { request_id: "r2", status: "pending", reopened: false } }), JOB, REASON, "admin_present"))
      .toMatchObject({ ok: true, reopened: false, message: expect.stringContaining("Waiting for an admin") });
    expect(await sendReopen(client({ data: { request_id: "r3", status: "approved", reopened: true } }), JOB, REASON, "admin_present"))
      .toMatchObject({ ok: true, status: "approved", message: "J-0012 reopened and signed off by you as admin." });
    expect(await sendReopen(client({ error: { code: "42883", message: "function public.reopen_record does not exist" } }), JOB, REASON, "admin_present")).toMatchObject({ ok: false, fallback: true });
    expect(await sendReopen(client({ error: { code: "22023", message: "J-0012 has been invoiced" } }), JOB, REASON, "admin_present")).toMatchObject({ ok: false });
  });
  it("fallback reopen is today's reopen_job; decisions go to decide_reopen_request", async () => {
    const legacy = client({});
    expect(await sendLegacyReopen(legacy, JOB, ` ${REASON} `)).toEqual({ ok: true });
    expect(legacy.calls).toEqual([{ fn: "reopen_job", args: { p_job: JOB.id, p_reason: REASON } }]);
    const d = client({ data: { status: "rejected", reopen_kept: true } });
    expect(await decideReopen(d, "r1", "reject", "  ")).toEqual({ ok: true, reopenedNow: false, reopenKept: true });
    expect(d.calls).toEqual([{ fn: "decide_reopen_request", args: { p_request: "r1", p_decision: "reject", p_note: null } }]);
  });
});

const html = (props: Partial<ReopenFormBodyProps>) => renderToStaticMarkup(createElement(ReopenFormBody, {
  jobNo: "J-0012", loading: false, fallback: false, preview: preview(), isAdmin: false, reason: "", confirmed: false, mode: null, error: null, busy: false,
  onReason: () => undefined, onConfirmed: () => undefined, onMode: () => undefined, onCancel: () => undefined, onSubmit: () => undefined, ...props,
}));

describe("the dialog as rendered", () => {
  it("not an admin: the confirmation sentence and both sign-off choices", () => {
    const out = html({ preview: preview({ draft_invoice: true }) });
    expect(out).toContain("I am reopening J-0012; its draft invoice stays a draft and is not issued.");
    expect(out).toContain("An admin is here: admin approval");
    expect(out).toContain("No admin available: reopen now and notify the admin");
    expect(out).toContain("does not undo the reopen");
    expect(out).not.toContain(REOPEN_FALLBACK_NOTICE);
  });
  it("an admin: approval recorded with the reopen, no tick box", () => {
    const out = html({ isAdmin: true, preview: preview({ is_admin: true }) });
    expect(out).toContain("You are an admin: your approval is recorded with the reopen.");
    expect(out).not.toContain("No admin available");
    expect(out).toContain("Approve and reopen");
  });
  it("an invoiced job (113: reopened through the sign-off): the sentence names the issued invoice, and both sign-off choices are offered", () => {
    const out = html({ preview: preview({ issued_invoices: ["INV-0010"] }) });
    expect(out).toContain("I am reopening J-0012; the issued invoice INV-0010 stays as it is.");
    expect(out).toContain("An admin is here: admin approval");
    expect(out).toContain("No admin available: reopen now and notify the admin");
    expect(out).not.toContain('role="alert"');
    expect(checkReopenForm({ reason: REASON, confirmed: true, mode: "tick_box_notify" }, { isAdmin: false, fallback: false, preview: preview({ issued_invoices: ["INV-0010"] }) })).toEqual({ ok: true, mode: "tick_box_notify" });
  });
  it("refused by the server (gone out on a delivery note, invoiced too): its reason, no choices, the button off", () => {
    const out = html({ preview: preview({ allowed: false, issued_invoices: ["INV-0010"], delivery_notes_out: ["DN-0004"], refusal: "J-0012 has gone out (DN-0004), so it can't be reopened." }) });
    expect(out).toContain("has gone out (DN-0004)");
    expect(out).toContain("the issued invoice INV-0010 stays as it is");
    expect(out).not.toContain("No admin available");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Reopen job<\/button>/);
  });
  it("fallback: the notice, the reason, and nothing about sign-off", () => {
    const out = html({ fallback: true, preview: null });
    expect(out).toContain("Admin approval recording is available after database update 113.");
    expect(out).toContain('name="reopen_reason"');
    expect(out).not.toContain("reopen_confirm");
    expect(out).not.toContain("No admin available");
    expect(out).toContain(">Reopen job</button>");
  });
});

describe("the Approval Queue list", () => {
  const rows = [
    { id: "a", record_ref: "J-0012", reason: REASON, requested_by: "u1", requested_at: "2026-10-30T09:00:00Z", approval_mode: "tick_box_notify" as const, reopened_at: "2026-10-30T09:00:00Z" },
    { id: "b", record_ref: "J-0013", reason: "Customer changed the drawing", requested_by: "u2", requested_at: "2026-10-30T10:00:00Z", approval_mode: "admin_present" as const, reopened_at: null },
  ];
  const list = (canDecide: boolean) => renderToStaticMarkup(createElement(ReopenApprovalsList, { rows, people: { u1: "Worker One" }, canDecide, busyId: null, onDecide: () => undefined }));
  it("shows each pending reopen: done with the tick box, or waiting; who asked and why", () => {
    const out = list(true);
    expect(out).toContain("REOPENED, NO ADMIN WAS AVAILABLE");
    expect(out).toContain("WAITING FOR AN ADMIN");
    expect(out).toContain("Worker One");
    expect(out).toContain(REASON);
    expect(out).toContain("does not undo");
    expect(out).toContain(">Approve and reopen</button>");
    expect(out).toContain(">Reject</button>");
  });
  it("an office user sees them but can't decide; nothing pending renders nothing", () => {
    const out = list(false);
    expect(out).toContain("An admin approves or rejects these with their own login.");
    expect(out).not.toContain(">Reject</button>");
    expect(renderToStaticMarkup(createElement(ReopenApprovalsList, { rows: [], people: {}, canDecide: true, busyId: null, onDecide: () => undefined }))).toBe("");
    expect(approvalLine(rows[1]).approveLabel).toBe("Approve and reopen");
    expect(approvalLine(rows[0]).approveLabel).toBe("Approve");
  });
});

// ---- the notify route ----
const route = vi.hoisted(() => ({
  user: { id: "u-requester" },
  org: "org-a",
  row: null as null | Record<string, unknown>,
  members: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/server/auth", async () => {
  const { NextResponse } = await import("next/server");
  return {
    sameOrigin: () => true,
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    isErrorResponse: (value: unknown) => value instanceof NextResponse,
    requireProfile: async () => ({
      user: route.user, profile: { organization_id: route.org, full_name: "Worker One" }, session: null,
      supabase: { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: route.row, error: null }) }; return q; } },
    }),
  };
});
vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      const q = { select: () => q, eq: () => q, in: () => q, then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "organization_members" ? route.members : route.profiles, error: null }).then(resolve) };
      return q;
    },
  }),
}));
vi.mock("@/lib/email/send-company-email", () => ({ sendCompanyEmail: async (input: Record<string, unknown>) => { route.sent.push(input); return { ok: true, mode: "drafted", provider: "none" }; } }));

const REQ = "22222222-2222-4222-8222-222222222222";
const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/reopen-requests/notify/route");
  const res = await POST(new Request("http://localhost/api/reopen-requests/notify", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};

describe("the notify route", () => {
  beforeEach(() => {
    route.sent = [];
    route.row = { id: REQ, organization_id: "org-a", record_ref: "J-0012\r\nBcc: x@evil.test", reason: REASON, requested_by: "u-requester", requested_at: new Date().toISOString(), status: "pending", approval_mode: "tick_box_notify", reopened_at: new Date().toISOString() };
    route.members = [{ user_id: "u-admin", role: "admin", secondary_role: null }, { user_id: "u-office", role: "office", secondary_role: "admin" }, { user_id: "u-w", role: "workshop", secondary_role: null }];
    route.profiles = [{ email: "admin@example.test" }, { email: "office@example.test" }];
  });
  it("e-mails the company's admins through the mailer contract, once per request, with no line breaks in the subject", async () => {
    expect(await post({ requestId: REQ })).toEqual({ status: 200, json: { emailed: true, mode: "drafted" } });
    expect(route.sent).toHaveLength(1);
    expect(route.sent[0]).toMatchObject({ organizationId: "org-a", userId: "u-requester", kind: "alert", to: ["admin@example.test", "office@example.test"],
      recordType: "reopen_request", recordId: REQ, idempotencyKey: `reopen-request-${REQ}` });
    expect(String(route.sent[0].subject)).not.toMatch(/[\r\n]/);
    expect(String(route.sent[0].text)).toContain("does not undo");
  });
  it("refuses a bad id, someone else's request, a decided one, an old one, and another company's", async () => {
    expect((await post({ requestId: "nope" })).status).toBe(400);
    route.row = { ...route.row!, requested_by: "someone-else" };
    expect((await post({ requestId: REQ })).status).toBe(409);
    route.row = { ...route.row!, requested_by: "u-requester", status: "approved" };
    expect((await post({ requestId: REQ })).status).toBe(409);
    route.row = { ...route.row!, status: "pending", requested_at: "2026-01-01T00:00:00Z" };
    expect((await post({ requestId: REQ })).status).toBe(409);
    route.row = { ...route.row!, requested_at: new Date().toISOString(), organization_id: "org-b" };
    expect((await post({ requestId: REQ })).status).toBe(404);
    route.row = null;
    expect((await post({ requestId: REQ })).status).toBe(404);
    expect(route.sent).toEqual([]);
  });
});
