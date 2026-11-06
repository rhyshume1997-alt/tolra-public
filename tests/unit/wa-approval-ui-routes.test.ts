/* eslint-disable @typescript-eslint/no-explicit-any */
// Worker W-A: Needs checking list, admin-only Resend choice, resolve route, provider-options, audit on direct-send failures. Mocks only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const S = vi.hoisted(() => ({ role: "admin", support: false, rows: [] as any[], rpc: [] as any[], updates: [] as any[], approveCalls: 0, mail: { ok: false, code: "provider_error", error: "x", uncertain: false } as any, env: { key: true }, job: "refuse" }));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true, forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }), isErrorResponse: (v: unknown) => v instanceof NextResponse,
  clientIp: () => "1.2.3.4",
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }), readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: async (roles: string[]) => !roles.includes(S.role) ? NextResponse.json({ error: "Forbidden" }, { status: 403 }) : ({
    supabase: {
      from: (t: string) => { let rows = S.rows.filter(() => true); let patch: any = null; const q: any = { select: () => q, eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; }, limit: () => q, neq: () => q, update: (p: any) => { patch = p; return q; }, maybeSingle: async () => ({ data: rows[0] ?? null, error: null }), then: (res: any) => { if (patch) { S.updates.push({ t, patch }); rows.forEach((r) => Object.assign(r, patch)); } return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(res); } }; return q; },
      rpc: async (fn: string, a: any) => { S.rpc.push({ fn, a }); return { data: fn === "reserve_job_email" ? { history_id: "hh1", replay: false, status: "sending" } : null, error: null }; },
    }, user: { id: "u1" }, profile: { id: "u1", organization_id: "o1", role: S.role }, session: { support: S.support },
  }),
}));
vi.mock("@/lib/email/send-company-email", async (orig) => {
  const real = await orig<typeof import("@/lib/email/send-company-email")>();
  return { ...real, sendCompanyEmail: vi.fn(async () => { S.approveCalls += 1; return S.mail; }), resendFromEnv: () => (S.env.key ? { name: "resend", send: async () => ({ outcome: "accepted", detail: "" }) } : null) };
});

vi.mock("@/lib/integrations/microsoft/token-source", () => ({ getDelegatedAccessToken: async () => null }));
vi.mock("resend", () => ({ Resend: class { emails = { send: async () => { if (S.job === "throw") throw new TypeError("net"); return { data: null, error: { name: "validation_error", statusCode: 422, message: "bad" } }; } }; } }));

import { NeedsChecking, SendViaResendButton } from "@/components/approval-recovery";
import { needsChecking } from "@/lib/approval-queue";

const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: "POST", body: JSON.stringify(body) });
const HID = "11111111-1111-4111-8111-111111111111";

describe("Needs checking list", () => {
  it("the queue helper selects exactly unknown and stuck-sending rows", () => {
    const calls: unknown[][] = []; const q: any = { in: (...a: unknown[]) => { calls.push(a); return q; } };
    needsChecking(q);
    expect(calls).toEqual([["status", ["unknown", "sending"]]]);
  });
  const item = { id: "h1", to: "pat@acme.test", subject: "Invoice INV-1", status: "unknown", related: "invoice", drafted: "1 Nov" };
  it("shows a clear status and no approve, retry or send-another-way control, only the two record-what-happened actions for an admin", () => {
    const html = renderToStaticMarkup(createElement(NeedsChecking, { items: [item, { ...item, id: "h2", status: "sending" }], isAdmin: true, busy: false, onResolve: () => {} }));
    expect(html).toContain("Needs checking");
    expect(html).toContain("We couldn&#x27;t confirm whether this email was sent");
    expect(html).toContain("being sent when something stopped");
    expect(html).toContain("I checked: it was sent");
    expect(html).not.toMatch(/Approve|Retry|Resend|Send via|Send again/i);
  });
  it("a non-admin gets no buttons at all", () => {
    const html = renderToStaticMarkup(createElement(NeedsChecking, { items: [item], isAdmin: false, busy: false, onResolve: () => {} }));
    expect(html).not.toContain("<button");
    expect(html).toContain("An admin needs to check");
  });
  it("renders nothing when nothing is held", () => {
    expect(renderToStaticMarkup(createElement(NeedsChecking, { items: [], isAdmin: true, busy: false, onResolve: () => {} }))).toBe("");
  });
});

describe("Send via Resend instead is only offered when available and the message failed", () => {
  const html = (available: boolean, failed: boolean) => renderToStaticMarkup(createElement(SendViaResendButton, { available, failed, disabled: false, onConfirm: () => {}, recipient: "a@b.test", subject: "S" }));
  it("hidden unless both", () => { expect(html(false, true)).toBe(""); expect(html(true, false)).toBe(""); expect(html(true, true)).toContain("Send via Resend instead"); });
});

describe("provider-options", () => {
  it("offers Resend to an admin with keys, never to office or without keys", async () => {
    const { GET } = await import("@/app/api/email/provider-options/route");
    S.role = "admin"; S.env.key = true; expect(await (await GET()).json()).toEqual({ admin: true, resend: true });
    S.env.key = false; expect(await (await GET()).json()).toEqual({ admin: true, resend: false });
    S.role = "office"; S.env.key = true; expect(await (await GET()).json()).toEqual({ admin: false, resend: false });
  });
});

describe("resolve route: records who and when, never sends", () => {
  beforeEach(() => { S.role = "admin"; S.support = false; S.rows = [{ id: HID, organization_id: "o1", status: "unknown", related_to_type: "invoice" }]; S.rpc = []; S.updates = []; S.approveCalls = 0; });
  it("office cannot call it", async () => {
    const { POST } = await import("@/app/api/email/resolve/route");
    S.role = "office";
    expect((await POST(post("/api/email/resolve", { history_id: HID, outcome: "sent" }))).status).toBe(403);
    expect(S.updates).toEqual([]);
  });
  it("sent: recorded as sent by hand, audit row with who-channel, nothing sent", async () => {
    const { POST } = await import("@/app/api/email/resolve/route");
    const res = await POST(post("/api/email/resolve", { history_id: HID, outcome: "sent" }));
    expect(await res.json()).toEqual({ status: "sent_manually", audited: true });
    expect(S.updates[0].patch.status).toBe("sent_manually");
    expect(S.rpc[0]).toMatchObject({ fn: "write_audit", a: { p_entity_id: HID, p_new: { outcome: "resolved_sent" }, p_metadata: { channel: "email-resolve" }, p_ip: "1.2.3.4" } });
    expect(S.approveCalls).toBe(0);
  });
  it("not sent: back to drafted for a fresh approval; a drafted or job row is refused", async () => {
    const { POST } = await import("@/app/api/email/resolve/route");
    expect((await (await POST(post("/api/email/resolve", { history_id: HID, outcome: "not_sent" }))).json()).status).toBe("drafted");
    S.rows = [{ id: HID, organization_id: "o1", status: "drafted", related_to_type: "invoice" }];
    expect((await POST(post("/api/email/resolve", { history_id: HID, outcome: "sent" }))).status).toBe(409);
    S.rows = [{ id: HID, organization_id: "o1", status: "unknown", related_to_type: "job" }];
    expect((await POST(post("/api/email/resolve", { history_id: HID, outcome: "sent" }))).status).toBe(409);
  });
});

describe("the approve routes: Resend choice is admin-only server side", () => {
  it("an office user posting provider resend is refused and nothing is sent", async () => {
    const { POST } = await import("@/app/api/email/approve/route");
    S.role = "office"; S.approveCalls = 0;
    S.rows = [{ id: HID, organization_id: "o1", status: "drafted", to_email: "a@b.test", subject: "S", body: "B", related_to_type: "general", related_to_id: "customer_statement:c:f", drafted_by: "u1" }];
    const res = await POST(post("/api/email/approve", { draft_id: HID, subject: "S", body: "B", to: "a@b.test", provider: "resend" }));
    expect(res.status).toBe(403);
    expect(S.approveCalls).toBe(0);
  });
});

describe("failed and uncertain direct sends leave an audit row", () => {
  const DOC = "22222222-2222-4222-8222-222222222222";
  it("/api/email/send audits a failure and an uncertain send against the document", async () => {
    const { POST } = await import("@/app/api/email/send/route");
    S.role = "office";
    S.rows = [{ id: DOC, organization_id: "o1", customer: "X", invoice_ref: "I-1", customer_email: "a@b.test" }];
    for (const uncertain of [false, true]) {
      S.rpc = []; S.mail = { ok: false, code: "provider_error", error: "x", uncertain };
      const res = await POST(post("/api/email/send", { kind: "invoice", record_id: DOC, to: ["a@b.test"], subject: "S", text: "T", idempotency_key: "fixture-key-0001" }));
      expect(res.status).toBe(502);
      expect(S.rpc).toHaveLength(1);
      expect(S.rpc[0].a).toMatchObject({ p_action: "UPDATE", p_entity_table: "invoices", p_entity_id: DOC, p_new: { outcome: uncertain ? "unknown" : "failed" }, p_metadata: { channel: "email-send", code: "provider_error" } });
      expect(JSON.stringify(S.rpc)).not.toMatch(/a@b\.test|"S"|"T"/);
    }
  });
});

describe("/api/send-job audits refused and unknown outcomes", () => {
  it("writes an audit row against the history id with codes only", async () => {
    const { POST } = await import("@/app/api/send-job/route");
    vi.stubEnv("RESEND_API_KEY", "re_fake"); vi.stubEnv("EMAIL_FROM", "S <a@sender.test>"); vi.spyOn(console, "error").mockImplementation(() => {});
    S.role = "office";
    S.rows = [{ id: "33333333-3333-4333-8333-333333333333", organization_id: "o1", customer_email: "buyer@x.test" }];
    for (const mode of ["refuse", "throw"]) {
      S.job = mode; S.rpc = [];
      const res = await POST(post("/api/send-job", { job_id: "33333333-3333-4333-8333-333333333333", recipient_email: "buyer@x.test", subject: "S", body: "B" }));
      expect(res.status).toBe(502);
      const audit = S.rpc.filter((c: any) => c.fn === "write_audit");
      expect(audit).toHaveLength(1);
      expect(audit[0].a).toMatchObject({ p_entity_table: "email_history", p_entity_id: "hh1", p_new: { outcome: mode === "refuse" ? "failed" : "unknown" }, p_metadata: { channel: "send-job" } });
      expect(JSON.stringify(audit)).not.toContain("buyer@x.test");
    }
    vi.unstubAllEnvs();
  });
});
