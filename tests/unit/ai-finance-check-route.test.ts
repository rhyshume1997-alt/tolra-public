/**
 * Tolra AI agent 1, the pre-issue finance check: the API routes, the panel and the never-do list.
 *   - Flag off (anything but exactly "true"): 404 before any sign-in check or read.
 *   - Admin and office only (workshop and viewers refused by requireProfile); a support session refused before any read.
 *   - Reads go through the caller's own client only, filtered to their company; nothing is inserted, updated, deleted or upserted,
 *     and the only function called is write_audit.
 *   - The four audit events carry their exact names and ids, kinds, codes and counts only (no names, amounts, text, IP or user agent).
 *   - Accepting a suggestion changes nothing on the document.
 *   - No service-role client, no model SDK, no secret in a log line.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const ORG = "o-1";
const INV = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_INV = "22222222-2222-4222-8222-222222222222";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  reads: [] as string[],
  writes: [] as string[],
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  auditError: null as null | { code: string },
}));

function builder(table: string) {
  let rows = [...(db.tables[table] ?? [])];
  const q = {
    select: (cols: string) => { db.reads.push(`${table}:${cols}`); return q; },
    eq: (c: string, v: unknown) => { rows = rows.filter((r) => !(c in r) || r[c] === v); return q; },
    neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return q; },
    in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
    gte: () => q, or: () => q, order: () => q,
    limit: (n: number) => { rows = rows.slice(0, n); return q; },
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    insert: () => { db.writes.push(`insert:${table}`); return q; },
    update: () => { db.writes.push(`update:${table}`); return q; },
    delete: () => { db.writes.push(`delete:${table}`); return q; },
    upsert: () => { db.writes.push(`upsert:${table}`); return q; },
  };
  return q;
}
const supabase = {
  from: (table: string) => builder(table),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    db.rpcs.push({ fn, args });
    return { data: null, error: fn === "write_audit" ? db.auditError : { code: "42501" } };
  },
};

const auth = vi.hoisted(() => ({ roles: [] as string[][], role: "office", support: false, calls: 0 }));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: vi.fn(async (roles: string[]) => {
    auth.calls += 1;
    auth.roles.push(roles);
    if (!roles.includes(auth.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return { supabase, user: { id: "u-1" }, profile: { id: "u-1", organization_id: ORG, role: auth.role }, session: { support: auth.support } };
  }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("service role used"); } }));

import { POST as check } from "@/app/api/ai/finance-check/route";
import { POST as decide } from "@/app/api/ai/finance-check/decision/route";
import { AiFeaturesProvider } from "@/components/ai-features";
import { AiFinanceCheckPanel } from "@/components/ai-finance-check-panel";
import { AI_AUDIT_ACTIONS, KIND_TABLE } from "@/lib/ai/finance-check/audit";
import { AI_FINANCE_CHECK_FLAG, aiFinanceCheckEnabled } from "@/lib/ai/finance-check/flag";
import { FINANCE_CHECK_ROLES } from "@/lib/ai/finance-check/request";

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
const runCheck = (body: unknown = { kind: "invoice", id: INV }) => check(post("/api/ai/finance-check", body));
const runDecision = (body: unknown) => decide(post("/api/ai/finance-check/decision", body));

function seed() {
  db.tables = {
    invoices: [
      { id: INV, organization_id: ORG, status: "draft", customer: "Acme Ltd", customer_po: null, job_id: null, subtotal: 50, vat: 10, total: 61, carriage: 0, carriage_vat: false, vat_enabled: true, invoice_date: "2026-10-20", created_at: "2026-10-20T09:00:00Z" },
      { id: OTHER_ORG_INV, organization_id: "o-2", status: "draft", customer: "Acme Ltd", total: 61, created_at: "2026-10-19T09:00:00Z" },
    ],
    invoice_line_items: [{ id: "il-1", organization_id: ORG, invoice_id: INV, position: 0, description: "Bracket", quantity: 10, unit_price: 5, vat_pct: 20, vat_exempt: false }],
    delivery_notes: [], delivery_note_items: [], sales_orders: [], sales_order_lines: [], quote_line_items: [],
    organization_settings: [{ organization_id: ORG, vat_registered: true, standard_rate: 20 }],
    purchase_orders: [], credit_notes: [], credit_note_lines: [],
  };
}

const logs: string[] = [];
beforeEach(() => {
  seed();
  db.reads = []; db.writes = []; db.rpcs = []; db.auditError = null;
  auth.roles = []; auth.role = "office"; auth.support = false; auth.calls = 0;
  vi.stubEnv(AI_FINANCE_CHECK_FLAG, "true");
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the switch", () => {
  it("only the exact value \"true\" turns it on", () => {
    for (const value of [undefined, "", "1", "TRUE", "yes", " true", "true "]) expect(aiFinanceCheckEnabled({ [AI_FINANCE_CHECK_FLAG]: value })).toBe(false);
    expect(aiFinanceCheckEnabled({ [AI_FINANCE_CHECK_FLAG]: "true" })).toBe(true);
  });

  it.each([undefined, "false", "1", "TRUE"])("flag %s: both routes answer 404 before sign-in or any read or audit", async (value) => {
    if (value === undefined) vi.stubEnv(AI_FINANCE_CHECK_FLAG, undefined as unknown as string);
    else vi.stubEnv(AI_FINANCE_CHECK_FLAG, value);
    expect((await runCheck()).status).toBe(404);
    expect((await runDecision({ kind: "invoice", id: INV, suggestionId: "totals_mismatch:total", code: "totals_mismatch", decision: "accepted" })).status).toBe(404);
    expect(auth.calls).toBe(0);
    expect(db.reads).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("the routes read the same env var name as lib/ai/finance-check/flag.ts", () => {
    for (const file of ["app/api/ai/finance-check/route.ts", "app/api/ai/finance-check/decision/route.ts"]) {
      expect(readFileSync(path.resolve(__dirname, "../..", file), "utf8")).toContain(`process.env.${AI_FINANCE_CHECK_FLAG} !== "true"`);
    }
  });

  it("flag off: the panel renders nothing; on: it renders the check, which never mentions blocking Issue", () => {
    const render = (on: boolean) => renderToStaticMarkup(createElement(AiFeaturesProvider, { value: { financeCheck: on } }, createElement(AiFinanceCheckPanel, { kind: "invoice", id: INV })));
    expect(render(false)).toBe("");
    expect(renderToStaticMarkup(createElement(AiFinanceCheckPanel, { kind: "invoice", id: INV }))).toBe("");
    const html = render(true);
    expect(html).toContain("Check before issue");
    expect(html).toContain("You can issue without waiting");
    expect(html).not.toContain("disabled");
    // A demo or missing id: nothing.
    expect(renderToStaticMarkup(createElement(AiFeaturesProvider, { value: { financeCheck: true } }, createElement(AiFinanceCheckPanel, { kind: "purchase_order", id: "demo-1" })))).toBe("");
  });
});

describe("who may run it", () => {
  it("asks for admin or office", async () => {
    await runCheck();
    expect(auth.roles).toEqual([["admin", "office"]]);
  });

  it.each(["workshop", "viewer"])("%s is refused before any read", async (role) => {
    auth.role = role;
    expect((await runCheck()).status).toBe(403);
    expect(db.reads).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("a support session is refused before any read or audit, on both routes", async () => {
    auth.role = "admin";
    auth.support = true;
    const res = await runCheck();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Support access can't run the finance check." });
    expect((await runDecision({ kind: "invoice", id: INV, suggestionId: "totals_mismatch:total", code: "totals_mismatch", decision: "accepted" })).status).toBe(403);
    expect(db.reads).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("refuses a bad body", async () => {
    expect((await runCheck({ kind: "quote", id: INV })).status).toBe(400);
    expect((await runCheck({ kind: "invoice", id: "1 or 1=1" })).status).toBe(400);
    expect((await runCheck({ kind: "invoice", id: INV, extra: "issue it" })).status).toBe(400);
  });
});

describe("the check", () => {
  it("returns suggestions, reads only (company-filtered), writes the two audit events with ids and codes only", async () => {
    const res = await runCheck();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checker).toBe("rules-v1");
    expect(body.suggestions.map((s: { code: string }) => s.code)).toEqual(["totals_mismatch"]);

    expect(db.writes).toEqual([]);
    expect(db.rpcs.map((r) => r.fn)).toEqual(["write_audit", "write_audit"]);
    const [requested, completed] = db.rpcs.map((r) => r.args);
    expect(requested).toEqual({ p_action: "ai_finance_check_requested", p_entity_table: "invoices", p_entity_id: INV, p_old: null, p_new: null, p_metadata: { kind: "invoice", checker: "rules-v1" }, p_ip: null, p_user_agent: null });
    expect(completed).toEqual({ p_action: "ai_finance_check_completed", p_entity_table: "invoices", p_entity_id: INV, p_old: null, p_new: null, p_metadata: { kind: "invoice", checker: "rules-v1", count: 1, codes: ["totals_mismatch"] }, p_ip: null, p_user_agent: null });
    expect(JSON.stringify(db.rpcs)).not.toMatch(/Acme|Bracket|61|50/);
  });

  it("another company's invoice is never part of the result (company filter on every read, as well as RLS)", async () => {
    db.tables.invoices[1] = { ...db.tables.invoices[1], customer: "Acme Ltd", total: 61, status: "draft", invoice_date: "2026-10-19" };
    db.tables.invoice_line_items.push({ id: "x-1", organization_id: "o-2", invoice_id: OTHER_ORG_INV, description: "Bracket", quantity: 10, unit_price: 5 });
    const body = await (await runCheck()).json();
    expect(JSON.stringify(body)).not.toContain(OTHER_ORG_INV);
    expect((await runCheck({ kind: "invoice", id: OTHER_ORG_INV })).status).toBe(404);
  });

  it("only drafts are checked", async () => {
    db.tables.invoices[0].status = "issued";
    expect((await runCheck()).status).toBe(409);
  });

  it("the database refusing the audit event means \"not available\", and the check does not run", async () => {
    db.auditError = { code: "42501" };
    const res = await runCheck();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Check not available" });
    expect(db.reads).toEqual([]);
  });

  it("runs for a purchase order and a credit note too", async () => {
    const PO = "33333333-3333-4333-8333-333333333333";
    const CN = "44444444-4444-4444-8444-444444444444";
    db.tables.purchase_orders = [{ id: PO, organization_id: ORG, status: "draft", supplier: "Steel Co", items: [{ description: "Bar", qty: 2, unit_price: 10 }], total_value: 25, vat_enabled: false, order_date: "2026-10-20" }];
    db.tables.credit_notes = [{ id: CN, organization_id: ORG, status: "draft", invoice_id: INV, subtotal: 50, vat: 10, total: 60, vat_enabled: true, credit_date: "2026-10-20" }];
    db.tables.credit_note_lines = [{ id: "cnl-1", organization_id: ORG, credit_note_id: CN, invoice_line_id: "il-1", quantity: 10, unit_price: 5, vat_pct: 20, vat_exempt: false, vat_amount: 10 }];
    const po = await (await runCheck({ kind: "purchase_order", id: PO })).json();
    expect(po.suggestions.map((s: { id: string }) => s.id)).toEqual(["totals_mismatch:subtotal"]);
    const cn = await (await runCheck({ kind: "credit_note", id: CN })).json();
    expect(cn.suggestions).toEqual([]);
    expect(db.rpcs.map((r) => r.args.p_entity_table)).toEqual(["purchase_orders", "purchase_orders", "credit_notes", "credit_notes"]);
    expect(db.writes).toEqual([]);
  });
});

describe("accept and reject", () => {
  const body = (decision: string) => ({ kind: "invoice", id: INV, suggestionId: "totals_mismatch:total", code: "totals_mismatch", decision });

  it("accept records ai_suggestion_accepted and changes nothing", async () => {
    const before = JSON.stringify(db.tables);
    const res = await runDecision(body("accepted"));
    expect(await res.json()).toEqual({ ok: true, changed: false });
    expect(JSON.stringify(db.tables)).toBe(before);
    expect(db.writes).toEqual([]);
    expect(db.rpcs).toEqual([{ fn: "write_audit", args: { p_action: "ai_suggestion_accepted", p_entity_table: "invoices", p_entity_id: INV, p_old: null, p_new: null, p_metadata: { kind: "invoice", checker: "rules-v1", suggestion_id: "totals_mismatch:total", code: "totals_mismatch" }, p_ip: null, p_user_agent: null } }]);
  });

  it("reject records ai_suggestion_rejected", async () => {
    await runDecision(body("rejected"));
    expect(db.rpcs.map((r) => r.args.p_action)).toEqual(["ai_suggestion_rejected"]);
  });

  it("refuses an unknown code, a mismatched id, or a document the caller can't see", async () => {
    expect((await runDecision({ ...body("accepted"), code: "issue_invoice", suggestionId: "issue_invoice:x" })).status).toBe(400);
    expect((await runDecision({ ...body("accepted"), suggestionId: "qty_mismatch:x" })).status).toBe(400);
    expect((await runDecision({ ...body("maybe") })).status).toBe(400);
    expect((await runDecision({ ...body("accepted"), id: OTHER_ORG_INV })).status).toBe(404);
    expect(db.rpcs).toEqual([]);
  });

  it("the four audit names are the reviewers' names", () => {
    expect(AI_AUDIT_ACTIONS).toEqual(["ai_finance_check_requested", "ai_finance_check_completed", "ai_suggestion_accepted", "ai_suggestion_rejected"]);
  });
});

describe("never-do list (static)", () => {
  const root = path.resolve(__dirname, "../..");
  const walk = (dir: string): string[] => (readdirSync(path.join(root, dir), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(dir, f));
  const files = [...walk("app/api/ai"), ...walk("lib/ai"), "components/ai-finance-check-panel.tsx", "components/ai-features.tsx"];
  const source = (f: string) => readFileSync(path.join(root, f), "utf8");

  it("finds the files", () => expect(files.length).toBeGreaterThanOrEqual(9));

  it("never uses the service role", () => {
    for (const f of files) expect(source(f), f).not.toMatch(/supabase-admin|createSupabaseAdminClient|SERVICE_ROLE/);
  });

  it("never issues, sends, voids or edits: no write method and no issuing function", () => {
    for (const f of files) {
      expect(source(f), f).not.toMatch(/\.(insert|update|upsert|delete)\(/);
      expect(source(f), f).not.toMatch(/issue_invoice|issue_credit_note|replace_draft_invoice|create_with_lines|void_invoice|persistPos|sendQueued/);
    }
    // The only database function called is write_audit.
    const rpcs = files.flatMap((f) => [...source(f).matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]));
    expect(rpcs).toEqual(["write_audit"]);
  });

  it("calls no model: no AI SDK, no key, no provider wired", () => {
    for (const f of files) expect(source(f), f).not.toMatch(/@anthropic-ai|openai|@ai-sdk|AI_API_KEY|fetch\("https?:/);
    // The SDK is in package.json for the separate AI admin helper (lib/ai-helper); the only file anywhere that imports it is that
    // helper's provider, so the finance check still reaches no model.
    const pkg = readFileSync(path.join(root, "package.json"), "utf8");
    expect(pkg).not.toMatch(/"openai"|"ai":/);
    const all = ["app", "lib", "components"].flatMap((dir) => walk(dir));
    expect(all.filter((f) => /from "@anthropic-ai\//.test(source(f)))).toEqual([path.join("lib", "ai-helper", "anthropic.ts")]);
  });

  it("reads no env var but the flag", () => {
    const envs = files.flatMap((f) => [...source(f).matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]));
    expect([...new Set(envs)]).toEqual([AI_FINANCE_CHECK_FLAG]);
  });

  it("logs codes only: no cookie, token or document data in a log line", async () => {
    db.auditError = { code: "42501" };
    await runCheck();
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toMatch(/Acme|Bracket|eyJ|cookie|token|sb-/i);
  });

  it("the database accepts these audit names from 095, on the three document tables the check names (audit_event_allowed)", () => {
    const dir = path.join(root, "supabase/migrations");
    const latest = readdirSync(dir).filter((f) => f.endsWith(".sql") && /FUNCTION public\.audit_event_allowed\(/.test(readFileSync(path.join(dir, f), "utf8"))).sort().at(-1)!;
    expect(latest).toMatch(/_ai_finance_check_audit_events\.sql$/);
    const sql = readFileSync(path.join(dir, latest), "utf8");
    expect(sql).toContain(`IF p_action IN (${AI_AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")}) THEN`);
    expect(sql).toContain(`RETURN p_table IN (${[...new Set(Object.values(KIND_TABLE))].map((t) => `'${t}'`).join(", ")}) AND public.has_org_role(ARRAY[${FINANCE_CHECK_ROLES.map((r) => `'${r}'`).join(", ")}]);`);
  });
});
