// Portal server: mocked RPC. Identical responses, `sends` never leaves the module, strict parsing, flag and key fail closed.
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("real admin client must not be created in a test"); } }));

import { codeHash, portalKey, refHash, tokenHash } from "@/lib/portal/crypto";
import { PORTAL_REFUSAL_STATUS, portalRefusalResponse } from "@/lib/portal/refusal";
import { endPortalSession, listPortalJobs, listPortalQuotes, requestPortalSignin, resolvePortalSession, verifyPortalSignin, type PortalServerDeps } from "@/lib/portal/server";

const KEY_B64 = randomBytes(32).toString("base64");
const env = { CUSTOMER_PORTAL_ENABLED: "true", PORTAL_SIGNIN_HMAC_KEY: KEY_B64, NEXT_PUBLIC_SITE_URL: "https://app.test", RESEND_API_KEY: "k", EMAIL_FROM: "Tolra <a@tolra.test>" };
const TOKEN = "t".repeat(43);
const REF = "r".repeat(22);
const SESSION = { contact_id: "c1", display_name: "Pat", company_name: "Acme", customer_name: "Pat Co", permissions: ["quotes", "jobs"], idle_expires_at: "2026-11-12T10:30:00Z", absolute_expires_at: "2026-11-12T18:00:00Z" };
const REFUSED = { ok: false, reason: "refused", correlation_id: "11111111-2222-3333-4444-555555555555" };

type Call = { fn: string; args: Record<string, unknown> };
function harness(answer: (fn: string, args: Record<string, unknown>) => unknown, overrides: Partial<PortalServerDeps> = {}) {
  const calls: Call[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const sent: Array<{ to: string[]; text: string }> = [];
  const send = vi.fn(async (m: { to: string[]; text: string }) => { sent.push(m); return { outcome: "accepted" }; });
  const deps: PortalServerDeps = {
    admin: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); const data = answer(fn, args); if (data instanceof Error) throw data; return { data, error: null }; } } as never,
    env, schedule: (t) => { tasks.push(t); }, mail: { providers: { resend: () => ({ name: "resend", send }) as never } }, ...overrides,
  };
  return { deps, calls, tasks, sent, send };
}
let logs: string[];
beforeEach(() => { logs = []; for (const m of ["error", "log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.map(String).join(" ")); }); });
afterEach(() => vi.restoreAllMocks());

describe("requestPortalSignin", () => {
  it("always sends 10 distinct, correctly hashed pairs and returns void", async () => {
    const h = harness(() => ({ ok: true, email: "pat@c.example", sends: [] }));
    expect(await requestPortalSignin("pat@c.example", h.deps)).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fn).toBe("portal_signin_request");
    const refs = h.calls[0].args.p_ref_hashes as string[]; const codes = h.calls[0].args.p_code_hashes as string[];
    expect(refs).toHaveLength(10); expect(codes).toHaveLength(10); expect(new Set(refs).size).toBe(10);
    for (const x of [...refs, ...codes]) expect(x).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns the same void whether the e-mail is a contact, unknown, refused or the call throws; sends only for real slots, in after()", async () => {
    let n = 0;
    const answers: unknown[] = [
      { ok: true, email: "pat@c.example", sends: [{ slot: 1, company_name: "Acme", customer_name: "Pat Co" }, { slot: 2, company_name: "Beta", customer_name: "Pat Beta" }] },
      { ok: true, email: "x@c.example", sends: [] }, REFUSED, new Error("down"), { junk: true },
    ];
    const h = harness(() => answers[n++]);
    const results = [];
    for (let i = 0; i < answers.length; i++) results.push(await requestPortalSignin("pat@c.example", h.deps));
    expect(results.every((r) => r === undefined)).toBe(true);
    expect(h.send).not.toHaveBeenCalled(); // nothing is mailed until after()
    expect(h.tasks).toHaveLength(1);
    await h.tasks[0]();
    expect(h.send).toHaveBeenCalledTimes(2);
    const texts = h.sent.map((m) => m.text);
    expect(texts[0]).toMatch(/https:\/\/app\.test\/portal\/code\/[A-Za-z0-9_-]{22}/);
    expect(texts[0]).not.toBe(texts[1]);
    expect(h.sent[0].to).toEqual(["pat@c.example"]);
  });
  it("mails the code that matches the hash sent to the database for that slot", async () => {
    const h = harness(() => ({ ok: true, email: "pat@c.example", sends: [{ slot: 3, company_name: "A", customer_name: "B" }] }));
    await requestPortalSignin("pat@c.example", h.deps);
    await h.tasks[0]();
    const text = h.sent[0].text;
    const ref = /portal\/code\/([A-Za-z0-9_-]{22})/.exec(text)![1];
    const code = /Your code: (\d{4}) (\d{4})/.exec(text)!.slice(1).join("");
    expect((h.calls[0].args.p_ref_hashes as string[])[2]).toBe(refHash(ref));
    expect((h.calls[0].args.p_code_hashes as string[])[2]).toBe(codeHash(portalKey(env)!, ref, code));
  });
  it("sends nothing when the site URL is unset", async () => {
    const h = harness(() => ({ ok: true, email: "pat@c.example", sends: [{ slot: 1, company_name: "A", customer_name: "B" }] }), { env: { ...env, NEXT_PUBLIC_SITE_URL: "" } });
    await requestPortalSignin("pat@c.example", h.deps);
    expect(h.tasks).toHaveLength(0);
  });
  it("platform flag off or key missing or bad key: no database call at all", async () => {
    for (const e of [{ ...env, CUSTOMER_PORTAL_ENABLED: undefined }, { ...env, CUSTOMER_PORTAL_ENABLED: "1" }, { ...env, PORTAL_SIGNIN_HMAC_KEY: undefined }, { ...env, PORTAL_SIGNIN_HMAC_KEY: randomBytes(8).toString("base64") }]) {
      const h = harness(() => ({ ok: true, email: "a@b.co", sends: [] }), { env: e });
      await requestPortalSignin("a@b.co", h.deps);
      expect(h.calls).toHaveLength(0);
    }
  });
  it("sends and the address never reach the logs", async () => {
    const h = harness(() => ({ ok: true, email: "secret.person@c.example", sends: [{ slot: 1, company_name: "A", customer_name: "B" }] }));
    await requestPortalSignin("secret.person@c.example", h.deps);
    await h.tasks[0]();
    expect(logs.join("\n")).not.toMatch(/secret\.person|portal\/code|\d{4} \d{4}/);
  });
  it("source returns no `sends` and uses after()", () => {
    const src = readFileSync("lib/portal/server.ts", "utf8");
    expect(src).toMatch(/after\)\(task\)/);
    expect(src).not.toMatch(/return[^;\n]*\bsends\b/);
  });
});

describe("verifyPortalSignin", () => {
  it("hashes ref, bound code and a fresh token; returns the session and the token", async () => {
    const h = harness(() => ({ ok: true, session: SESSION }));
    const out = await verifyPortalSignin({ ref: REF, code: "1234 5678" }, h.deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.session).toEqual({ contactId: "c1", displayName: "Pat", companyName: "Acme", customerName: "Pat Co", permissions: ["quotes", "jobs"], idleExpiresAt: SESSION.idle_expires_at, absoluteExpiresAt: SESSION.absolute_expires_at });
    expect(h.calls[0].fn).toBe("portal_signin_verify");
    expect(h.calls[0].args).toEqual({ p_ref_hash: refHash(REF), p_code_hash: codeHash(portalKey(env)!, REF, "12345678"), p_token_hash: tokenHash(out.data.token) });
    expect(out.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("a database refusal keeps only its correlation id", async () => {
    const out = await verifyPortalSignin({ ref: REF, code: "12345678" }, harness(() => REFUSED).deps);
    expect(out).toEqual({ ok: false, reason: "refused", correlationId: REFUSED.correlation_id });
  });
  it("bad input, flag off, missing key: refusal with no database call", async () => {
    for (const [input, e] of [[{ ref: "short", code: "12345678" }, env], [{ ref: REF, code: "1234" }, env], [{ ref: REF, code: "12345678" }, { ...env, CUSTOMER_PORTAL_ENABLED: "" }], [{ ref: REF, code: "12345678" }, { ...env, PORTAL_SIGNIN_HMAC_KEY: undefined }]] as const) {
      const h = harness(() => ({ ok: true, session: SESSION }), { env: e });
      const out = await verifyPortalSignin(input, h.deps);
      expect(out).toMatchObject({ ok: false, reason: "refused" });
      expect(h.calls).toHaveLength(0);
    }
  });
});

describe("strict parsing and the one refusal", () => {
  const weird: unknown[] = [null, "x", {}, { ok: true }, { ok: true, session: { ...SESSION, email: "a@b.co" } }, { ok: true, session: { ...SESSION, permissions: ["admin"] } }, { ok: true, session: { ...SESSION, permissions: [] } }, { ok: true, session: SESSION, extra: 1 }, { ok: false, reason: "wrong_code", correlation_id: "x" }, { ok: false, reason: "refused" }];
  it("any unexpected shape is a refusal, never data", async () => {
    for (const w of weird) {
      expect(await verifyPortalSignin({ ref: REF, code: "12345678" }, harness(() => w).deps)).toMatchObject({ ok: false, reason: "refused" });
      expect(await resolvePortalSession(TOKEN, harness(() => w).deps)).toMatchObject({ ok: false, reason: "refused" });
    }
  });
  it("an RPC error, a thrown call, a missing client (154 not applied) are refusals", async () => {
    const err = { admin: { rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as never };
    expect(await resolvePortalSession(TOKEN, harness(() => null, err).deps)).toMatchObject({ ok: false, reason: "refused" });
    expect(await resolvePortalSession(TOKEN, harness(() => new Error("x")).deps)).toMatchObject({ ok: false, reason: "refused" });
    expect(await resolvePortalSession(TOKEN, harness(() => null, { admin: null }).deps)).toMatchObject({ ok: false, reason: "refused" });
  });
  it("every refusal has the same shape and HTTP status; logs hold only a correlation id", async () => {
    const outs = [await resolvePortalSession("bad", harness(() => null).deps), await resolvePortalSession(TOKEN, harness(() => REFUSED).deps), await resolvePortalSession(TOKEN, harness(() => ({})).deps)];
    for (const o of outs) { expect(Object.keys(o).sort()).toEqual(["correlationId", "ok", "reason"]); const r = portalRefusalResponse(o as never); expect(r.status).toBe(PORTAL_REFUSAL_STATUS); expect(Object.keys(await r.json()).sort()).toEqual(["correlationId", "ok", "reason"]); }
    for (const line of logs) expect(line).toMatch(/^\[portal\] refused [0-9a-f-]{36}$|^\[portal\] refused 11111111-/);
  });
});

describe("resolve, end, quotes and jobs", () => {
  it("resolve sends only the token hash", async () => {
    const h = harness(() => ({ ok: true, session: SESSION }));
    const out = await resolvePortalSession(TOKEN, h.deps);
    expect(out.ok).toBe(true);
    expect(h.calls[0]).toEqual({ fn: "portal_session_resolve", args: { p_token_hash: tokenHash(TOKEN) } });
  });
  it("a malformed token or the flag off makes no database call", async () => {
    const h = harness(() => ({ ok: true, session: SESSION }));
    expect(await resolvePortalSession("nope", h.deps)).toMatchObject({ ok: false });
    expect(await listPortalQuotes(undefined, h.deps)).toMatchObject({ ok: false });
    expect(await listPortalJobs(TOKEN, { ...h.deps, env: {} })).toMatchObject({ ok: false });
    await endPortalSession(TOKEN, { ...h.deps, env: {} });
    expect(h.calls).toHaveLength(0);
  });
  it("end calls portal_session_end and never throws", async () => {
    const h = harness(() => ({ ok: true }));
    await endPortalSession(TOKEN, h.deps);
    expect(h.calls[0]).toEqual({ fn: "portal_session_end", args: { p_token_hash: tokenHash(TOKEN) } });
    await expect(endPortalSession(TOKEN, harness(() => new Error("x")).deps)).resolves.toBeUndefined();
  });
  it("quotes map and normalise numeric totals; unknown fields or statuses refuse", async () => {
    const q = { quote_ref: "Q-1", status: "sent", sent_at: "2026-11-01T00:00:00Z", valid_until: null, customer_po: null, total_value: "120.50" };
    const out = await listPortalQuotes(TOKEN, harness(() => ({ ok: true, quotes: [q] })).deps);
    expect(out).toEqual({ ok: true, data: [{ quoteRef: "Q-1", status: "sent", sentAt: "2026-11-01T00:00:00Z", validUntil: null, customerPo: null, totalValue: 120.5 }] });
    expect(await listPortalQuotes(TOKEN, harness(() => ({ ok: true, quotes: [{ ...q, status: "draft" }] })).deps)).toMatchObject({ ok: false });
    expect(await listPortalQuotes(TOKEN, harness(() => ({ ok: true, quotes: [{ ...q, margin: 5 }] })).deps)).toMatchObject({ ok: false });
  });
  it("jobs map the three stages only", async () => {
    const j = { job_no: "J-1", customer_po: "PO", due_date: "2026-12-01", stage: "in_progress" };
    expect(await listPortalJobs(TOKEN, harness(() => ({ ok: true, jobs: [j] })).deps)).toEqual({ ok: true, data: [{ jobNo: "J-1", customerPo: "PO", dueDate: "2026-12-01", stage: "in_progress" }] });
    expect(await listPortalJobs(TOKEN, harness(() => ({ ok: true, jobs: [{ ...j, stage: "rework" }] })).deps)).toMatchObject({ ok: false });
  });
});
