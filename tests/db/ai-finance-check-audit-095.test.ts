/**
 * Migration 095: the audit log accepts Tolra AI agent 1's four finance-check events (lib/ai/finance-check/audit.ts), and nothing else
 * changes.
 *
 *   - the four events are accepted on invoices, purchase_orders and credit_notes, for admin and office, with the app's metadata;
 *   - the same names on any other table, from any other role, or with any other shape (an extra key, a wrong kind, an unknown code,
 *     an old or new row, a non-UUID id) are refused 42501;
 *   - every other event answers exactly as 076's audit_event_allowed did, for every role, and the allowed ones still write;
 *   - another company is unaffected: its events are its own, and A's events never reach it.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), so it runs on the local stack and on a plain Postgres rebuild
 * with Supabase stand-ins.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `095 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-095-${label}-${counter}`]);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** One API request: its own transaction, as role authenticated with the person's claims (as PostgREST runs it). */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/** write_audit inside a savepoint: the SQLSTATE it raised, or "ok". */
async function tryWrite(db: Client, action: string, table: string, id: string, metadata: unknown, oldData: unknown = null, newData: unknown = null) {
  await db.query("savepoint w");
  try {
    await db.query("select public.write_audit($1, $2, $3, $4, $5, $6, null, null)",
      [action, table, id, oldData === null ? null : JSON.stringify(oldData), newData === null ? null : JSON.stringify(newData), metadata === null ? null : JSON.stringify(metadata)]);
    await db.query("release savepoint w");
    return "ok";
  } catch (error) {
    await db.query("rollback to savepoint w");
    return (error as { code?: string }).code ?? "error";
  }
}

const AI = ["ai_finance_check_requested", "ai_finance_check_completed", "ai_suggestion_accepted", "ai_suggestion_rejected"] as const;
const KIND = { invoices: "invoice", purchase_orders: "purchase_order", credit_notes: "credit_note" } as const;
type DocTable = keyof typeof KIND;
const DOC_TABLES = Object.keys(KIND) as DocTable[];

/** The metadata writeAiAudit sends for each event (audit.ts: { ...metadata, kind, checker: "rules-v1" }). */
function appMetadata(action: (typeof AI)[number], table: DocTable) {
  const base = { kind: KIND[table], checker: "rules-v1" };
  if (action === "ai_finance_check_requested") return base;
  if (action === "ai_finance_check_completed") return { count: 3, codes: ["qty_mismatch", "possible_duplicate"], ...base };
  return { suggestion_id: `possible_duplicate:${randomUUID()}`, code: "possible_duplicate", ...base };
}

// Every action and table name 076's allow-list knows, plus names it doesn't.
const ACTIONS = [
  "CHANGE_OWN_PASSWORD", "CREATE_USER", "SET_USER_PASSWORD", "UPDATE_USERNAME", "UPDATE_USER_ACCESS", "DEACTIVATE_USER", "REACTIVATE_USER",
  "INVITE_USER", "PASSWORD_RESET_PREPARED", "RESET_MFA", "EXPORT", "PRINT_PACK", "DOWNLOAD_PDF", "DOWNLOAD_ATTACHMENT", "EMAIL_COPIED",
  "CREATE", "UPDATE", "DELETE", "SEND", "DESPATCH", "ACCEPT", "REJECT", "UPDATE_WORKSHEET", "UPLOAD_DRAWING", "CONVERT_TO_JOB",
  "SEND_TO_WORKSHOP", "MARK_RECEIVED", "MARK_PAID", "MARK_SIGNED", "UPLOAD_ATTACHMENT", "EMAIL_SENT_MANUALLY", "DRAFT_CHASERS",
  "CREATE_SUPPLIER", "DELETE_SUPPLIER", "ORGANIZATION_SETTINGS_UPDATE",
  "IMPORT_COMMITTED", "GRANT_COMPANY_ACCESS", "ISSUE", "RECORD_PAYMENT", "AI_FINANCE_CHECK_REQUESTED", "ai_finance_check", "nonsense",
];
const TABLES = [
  "quotes", "quote_attachments", "rfqs", "customers", "suppliers", "purchase_orders", "stock", "email_history", "invoices", "sales_orders",
  "jobs", "machines", "machine_bookings", "delivery_notes", "user_profiles", "organization_settings", "invoice_payments", "time_week_approvals",
  "credit_notes", "credit_note_lines", "invoice_line_items", "import_batches", "job_machines", "nonsense",
];

const W = {
  A: "", B: "",
  adminA: person("admin-a"), officeA: person("office-a"), workshopA: person("workshop-a"), viewerA: person("viewer-a"),
  adminB: person("admin-b"), viewerB: person("viewer-b"),
};
const ROLES_A = () => [W.adminA, W.officeA, W.workshopA, W.viewerA];

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.B = await makeOrg(db, "b");
    await member(db, W.A, W.adminA, "admin");
    await member(db, W.A, W.officeA, "office");
    await member(db, W.A, W.workshopA, "workshop");
    await member(db, W.A, W.viewerA, "viewer");
    await member(db, W.B, W.adminB, "admin");
    await member(db, W.B, W.viewerB, "viewer");
    // 076's audit_event_allowed, verbatim from its file under another name: the reference for the regression set (dropped after).
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/076_data_import.sql"), "utf8");
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.audit_event_allowed(");
    const def = sql.slice(start, sql.indexOf("$function$;", start) + "$function$;".length);
    await db.query(def.replace("FUNCTION public.audit_event_allowed(", `FUNCTION public.zz_aea076_${run}(`));
    await db.query(`grant execute on function public.zz_aea076_${run}(text, text) to authenticated`);
  });
});

afterAll(async () => {
  await withDb((db) => db.query(`drop function if exists public.zz_aea076_${run}(text, text)`));
  await destroySyntheticWorld(run);
});

const stored = (org: string) => withDb(async (db) => (await db.query<{ action: string; entity_table: string; entity_id: string; actor_user_id: string; metadata: Record<string, unknown> }>(
  "select action, entity_table, entity_id, actor_user_id, metadata from security_audit.audit_log where organization_id = $1 and action like 'ai\\_%' order by created_at, id", [org])).rows);

describe("095: the four finance-check events are accepted on the three document tables", () => {
  it("admin and office may record each event on invoices, purchase orders and credit notes, with the app's metadata", async () => {
    const written: Array<{ action: string; table: string; id: string }> = [];
    for (const p of [W.adminA, W.officeA]) {
      await as(p, async (db) => {
        for (const table of DOC_TABLES) {
          for (const action of AI) {
            const id = randomUUID();
            expect(await tryWrite(db, action, table, id, appMetadata(action, table)), `${action} on ${table}`).toBe("ok");
            written.push({ action, table, id });
          }
        }
      });
    }
    expect(written).toHaveLength(24);
    const rows = await stored(W.A);
    expect(rows.map((r) => `${r.action} ${r.entity_table} ${r.entity_id}`)).toEqual(written.map((w) => `${w.action} ${w.table} ${w.id}`));
    // Stored as any write_audit row: the caller, their company, the app's metadata plus source write_audit.
    expect(rows.slice(0, 12).every((r) => r.actor_user_id === W.adminA.id)).toBe(true);
    expect(rows[0].metadata).toEqual({ kind: "invoice", checker: "rules-v1", source: "write_audit" });
    expect(rows[1].metadata).toEqual({ kind: "invoice", checker: "rules-v1", count: 3, codes: ["qty_mismatch", "possible_duplicate"], source: "write_audit" });
  });

  it("each event's other app shapes: a check with no suggestions, and a dismissed suggestion", async () => {
    await as(W.officeA, async (db) => {
      expect(await tryWrite(db, "ai_finance_check_completed", "credit_notes", randomUUID(), { count: 0, codes: [], kind: "credit_note", checker: "rules-v1" })).toBe("ok");
      expect(await tryWrite(db, "ai_suggestion_rejected", "invoices", randomUUID(),
        { suggestion_id: "qty_mismatch:line-2:order", code: "qty_mismatch", kind: "invoice", checker: "rules-v1" })).toBe("ok");
      expect(await tryWrite(db, "ai_suggestion_accepted", "purchase_orders", randomUUID(),
        { suggestion_id: "totals_mismatch:subtotal-vat", code: "totals_mismatch", kind: "purchase_order", checker: "rules-v1" })).toBe("ok");
    });
  });

  it("workshop and viewers may not record them on any table", async () => {
    for (const p of [W.workshopA, W.viewerA]) {
      await as(p, async (db) => {
        for (const table of DOC_TABLES) for (const action of AI) expect(await tryWrite(db, action, table, randomUUID(), appMetadata(action, table))).toBe("42501");
      });
    }
  });
});

describe("095: the same names anywhere else, or in any other shape, are refused", () => {
  it("on any other table (with the kind the nearest document would carry), for every role", async () => {
    const others = TABLES.filter((t) => !DOC_TABLES.includes(t as DocTable));
    for (const p of ROLES_A()) {
      await as(p, async (db) => {
        for (const table of others) {
          for (const action of AI) {
            expect(await tryWrite(db, action, table, randomUUID(), appMetadata(action, "invoices")), `${action} on ${table}`).toBe("42501");
            expect(await db.query("select public.audit_event_allowed($1, $2) as v", [action, table]).then((r) => r.rows[0].v)).toBe(false);
          }
        }
      });
    }
  });

  it("with any metadata, row or id other than the app sends", async () => {
    const inv = (m: Record<string, unknown>) => ({ kind: "invoice", checker: "rules-v1", ...m });
    const bad: Array<[string, string, string, unknown, unknown?, unknown?]> = [
      ["extra key (an amount)", "ai_finance_check_requested", "invoices", inv({ total: 120 })],
      ["a name", "ai_finance_check_requested", "invoices", inv({ customer: "Acme" })],
      ["no checker", "ai_finance_check_requested", "invoices", { kind: "invoice" }],
      ["another checker", "ai_finance_check_requested", "invoices", { kind: "invoice", checker: "model-v2" }],
      ["no kind", "ai_finance_check_requested", "invoices", { checker: "rules-v1" }],
      ["kind of another table", "ai_finance_check_requested", "invoices", { kind: "credit_note", checker: "rules-v1" }],
      ["kind not a string", "ai_finance_check_requested", "invoices", { kind: ["invoice"], checker: "rules-v1" }],
      ["empty metadata", "ai_finance_check_requested", "invoices", {}],
      ["metadata not an object", "ai_finance_check_requested", "invoices", ["invoice"]],
      ["no metadata", "ai_finance_check_requested", "invoices", null],
      ["requested with counts", "ai_finance_check_requested", "invoices", inv({ count: 1, codes: ["qty_mismatch"] })],
      ["completed without codes", "ai_finance_check_completed", "invoices", inv({ count: 1 })],
      ["completed without count", "ai_finance_check_completed", "invoices", inv({ codes: [] })],
      ["unknown code", "ai_finance_check_completed", "invoices", inv({ count: 1, codes: ["made_up"] })],
      ["code not a string", "ai_finance_check_completed", "invoices", inv({ count: 1, codes: [7] })],
      ["repeated code", "ai_finance_check_completed", "invoices", inv({ count: 2, codes: ["qty_mismatch", "qty_mismatch"] })],
      ["more codes than suggestions", "ai_finance_check_completed", "invoices", inv({ count: 1, codes: ["qty_mismatch", "vat_mismatch"] })],
      ["negative count", "ai_finance_check_completed", "invoices", inv({ count: -1, codes: [] })],
      ["fractional count", "ai_finance_check_completed", "invoices", inv({ count: 1.5, codes: [] })],
      ["count as text", "ai_finance_check_completed", "invoices", inv({ count: "1", codes: [] })],
      ["codes not an array", "ai_finance_check_completed", "invoices", inv({ count: 1, codes: "qty_mismatch" })],
      ["decision without a code", "ai_suggestion_accepted", "invoices", inv({ suggestion_id: "qty_mismatch:x" })],
      ["decision with an unknown code", "ai_suggestion_accepted", "invoices", inv({ suggestion_id: "made_up:x", code: "made_up" })],
      ["suggestion of another code", "ai_suggestion_rejected", "invoices", inv({ suggestion_id: "vat_mismatch:x", code: "qty_mismatch" })],
      ["suggestion id with text", "ai_suggestion_rejected", "invoices", inv({ suggestion_id: "qty_mismatch:Flange 10 mm", code: "qty_mismatch" })],
      ["decision with a count", "ai_suggestion_rejected", "invoices", inv({ suggestion_id: "qty_mismatch:x", code: "qty_mismatch", count: 1 })],
      ["a new row", "ai_finance_check_requested", "invoices", inv({}), null, { total: 120 }],
      ["an old row", "ai_finance_check_requested", "invoices", inv({}), { total: 120 }, null],
    ];
    await as(W.adminA, async (db) => {
      for (const [what, action, table, metadata, oldData = null, newData = null] of bad) {
        expect(await tryWrite(db, action, table, randomUUID(), metadata, oldData, newData), what).toBe("42501");
      }
      expect(await tryWrite(db, "ai_finance_check_requested", "invoices", "INV-0001", inv({})), "an id that isn't a UUID").toBe("42501");
      expect(await tryWrite(db, "ai_finance_check_requested", "invoices", null as unknown as string, inv({})), "no id").toBe("42501");
    });
  });
});

describe("095: every other event is unchanged", () => {
  it("audit_event_allowed answers exactly as 076's for every other action, table and role", async () => {
    for (const p of [...ROLES_A(), W.adminB, W.viewerB]) {
      const diff = await as(p, async (db) => (await db.query<{ a: string; t: string }>(
        `select a, t from unnest($1::text[]) a, unnest($2::text[]) t
          where public.audit_event_allowed(a, t) is distinct from public.zz_aea076_${run}(a, t)`, [ACTIONS, TABLES])).rows);
      expect(diff, `role of ${p.email}`).toEqual([]);
    }
    // The comparison is not empty: 076 allows a good share of the cross-product for an admin and nothing for an unknown name.
    const allowed = await as(W.adminA, async (db) => (await db.query<{ n: number }>(
      `select count(*)::int as n from unnest($1::text[]) a, unnest($2::text[]) t where public.zz_aea076_${run}(a, t)`, [ACTIONS, TABLES])).rows[0].n);
    expect(allowed).toBeGreaterThan(300);
  });

  it("every event 076 allows still writes through write_audit, for every role (the payment events stay the database's own)", async () => {
    for (const p of ROLES_A()) {
      await as(p, async (db) => {
        const pairs = (await db.query<{ a: string; t: string }>(
          `select a, t from unnest($1::text[]) a, unnest($2::text[]) t where public.zz_aea076_${run}(a, t) order by a, t`, [ACTIONS, TABLES])).rows;
        expect(pairs.length).toBeGreaterThan(0);
        for (const { a, t } of pairs) {
          const id = a === "CHANGE_OWN_PASSWORD" ? p.id : randomUUID();
          const outcome = await tryWrite(db, a, t, id, { note: "regression" }, { x: 1 }, { x: 2 });
          expect(outcome, `${a} on ${t}`).toBe(a === "MARK_PAID" ? "42501" : "ok");
        }
        // And what 076 refuses is still refused.
        expect(await tryWrite(db, "IMPORT_COMMITTED", "import_batches", randomUUID(), {})).toBe("42501");
        expect(await tryWrite(db, "nonsense", "invoices", randomUUID(), {})).toBe("42501");
      });
    }
  });
});

describe("095: other companies are unaffected", () => {
  it("B's events are B's own, A's never reach B, and B's viewer is still refused", async () => {
    const before = await withDb(async (db) => (await db.query<{ n: number }>("select count(*)::int as n from security_audit.audit_log where organization_id = $1", [W.B])).rows[0].n);
    await as(W.adminA, async (db) => {
      expect(await tryWrite(db, "ai_finance_check_requested", "invoices", randomUUID(), appMetadata("ai_finance_check_requested", "invoices"))).toBe("ok");
    });
    const afterA = await withDb(async (db) => (await db.query<{ n: number }>("select count(*)::int as n from security_audit.audit_log where organization_id = $1", [W.B])).rows[0].n);
    expect(afterA).toBe(before);
    expect(await stored(W.B)).toEqual([]);
    const id = randomUUID();
    await as(W.adminB, async (db) => {
      expect(await tryWrite(db, "ai_finance_check_requested", "credit_notes", id, appMetadata("ai_finance_check_requested", "credit_notes"))).toBe("ok");
      expect(await tryWrite(db, "EXPORT", "invoices", randomUUID(), {})).toBe("ok");
    });
    await as(W.viewerB, async (db) => {
      expect(await tryWrite(db, "ai_finance_check_requested", "credit_notes", randomUUID(), appMetadata("ai_finance_check_requested", "credit_notes"))).toBe("42501");
    });
    const b = await stored(W.B);
    expect(b.map((r) => `${r.action} ${r.entity_table} ${r.entity_id} ${r.actor_user_id}`)).toEqual([`ai_finance_check_requested credit_notes ${id} ${W.adminB.id}`]);
    expect((await stored(W.A)).some((r) => r.entity_id === id)).toBe(false);
  });
});
