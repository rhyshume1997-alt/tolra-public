/**
 * Integrations layer + Xero connect and push (migration 084, G22). Per company, off by default; one way, Tolra to Xero only. Proves in
 * SQL (as PostgREST runs it: role authenticated with the JWT claims, or the service role for the server's own calls), so it also runs
 * against plain PostgreSQL with stand-ins:
 *   - roles and RLS: only the company's admins read the connection, mappings, contacts and send log; nobody signed in reads the tokens or
 *     the OAuth states, through any path; the server-only functions can't be called from the API; two-step sign-in where it is on;
 *   - the tokens are ciphertext only, never in the audit log; a Xero organisation is linked to one company;
 *   - the queue: nothing queued while not connected or for an import; each document and action once (keyed by its id); the gate
 *     (connected and every account and VAT rate used mapped); one claimant per row; a result only from the claim that holds it; a lost
 *     claim becomes needs_check; voids; retry; disconnect;
 *   - the refresh lease: one holder at a time (the second waits on the row lock and gets nothing), a store only by the holder;
 *   - each line's VAT key (the one place they are worked out) and contact matches (never a guess).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, as, q, refusal } from "./time-support";

let world: SyntheticWorld;
let seq = 0;
let alphaTenant = "";
const alpha = () => world.tenants.alpha;
const beta = () => world.tenants.beta;
const user = (role: "admin" | "office" | "workshop" | "viewer", t = alpha()): Who => ({ id: t.users[role].id });

/** A ciphertext in the server's form (lib/integrations/crypto.ts): v<version>.<iv>.<tag>.<data>, base64url. Never a real token. */
const cipher = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}`;
const hash = () => randomBytes(32).toString("hex");

/** One statement as the service role (the server's own client): no JWT claims. */
async function svc<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      const rows = (await db.query<R>(text, params)).rows;
      await db.query("commit");
      return rows;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}
async function svcRefusal(text: string, params: unknown[] = []) {
  try {
    await svc(text, params);
    return null;
  } catch (err) {
    const e = err as { code?: string; hint?: string; message: string };
    return { code: e.code, hint: e.hint, message: e.message };
  }
}
const owner = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows);

/** Connects a company to a Xero tenant the way the callback does: begin as the admin, consume and store as the server. */
async function connect(t = alpha(), tenant = `tenant-${randomUUID()}`) {
  const state = hash();
  await q(user("admin", t), "select public.integration_oauth_begin('xero', $1, $2) as id", [state, cipher()]);
  await svc("select public.integration_oauth_consume($1, $2, 'xero', $3) as r", [t.id, t.users.admin.id, state]);
  await svc("select public.integration_store_connection($1, $2, 'xero', $3, $4, $5, $6, $7, now() + interval '30 minutes', 1) as r",
    [t.id, t.users.admin.id, tenant, `${t.name} Xero`, randomUUID(), cipher(), cipher()]);
  return tenant;
}
async function disconnect(t = alpha()) {
  await q(user("admin", t), "select public.integration_disconnect('xero') as r");
}
async function mapAll(t = alpha(), keys = ["20"]) {
  await q(user("admin", t), "select public.integration_set_mapping('xero', 'sales_account', null, '200', 'Sales') as r");
  await q(user("admin", t), "select public.integration_set_mapping('xero', 'credit_account', null, '200', 'Sales') as r");
  for (const k of keys) await q(user("admin", t), "select public.integration_set_mapping('xero', 'tax_rate', $1, $2, $3) as r", [k, `OUTPUT${k}`, `VAT ${k}`]);
}

type Line = { description?: string; quantity?: number; unit_price: number; vat_pct?: number; vat_exempt?: boolean };
/** A draft invoice with lines, written as the owner; issued with issue() (status draft -> issued, as issue_invoice does). */
async function invoice(t = alpha(), lines: Line[] = [{ unit_price: 100 }], extra: { vat_enabled?: boolean; carriage?: number; carriage_vat?: boolean } = {}) {
  seq += 1;
  return withDb(async (db) => {
    const id = (await db.query<{ id: string }>(
      `insert into public.invoices (organization_id, customer, status, subtotal, vat, total, vat_enabled, carriage, carriage_vat, due_date, invoice_date)
       values ($1, 'Acme Engineering Ltd', 'draft', 0, 0, 0, $2, $3, $4, '2026-11-30', '2026-10-21') returning id`,
      [t.id, extra.vat_enabled ?? true, extra.carriage ?? 0, extra.carriage_vat ?? false])).rows[0].id;
    for (const [i, l] of lines.entries()) {
      await db.query(`insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
                      values ($1, $2, $3, $4, $5, $6, $7, $8)`, [t.id, id, i, l.description ?? `Part ${i}`, l.quantity ?? 1, l.unit_price, l.vat_pct ?? 20, l.vat_exempt ?? false]);
    }
    return id;
  });
}
const issue = (id: string, db?: (sql: string, p: unknown[]) => Promise<unknown>) => (db ?? owner)(
  "update public.invoices set status = 'issued', invoice_ref = $2, issued_at = now() where id = $1", [id, `INV-X84-${world.runId}-${(seq += 1)}`]);
const voidIt = (id: string) => withDb(async (db) => {
  await db.query("begin");
  await db.query("select set_config('quoteflow.invoice_void', $1, true)", [id]);
  await db.query("update public.invoices set status = 'void' where id = $1", [id]);
  await db.query("commit");
});
const sends = (id: string) => owner<{ action: string; status: string; attempts: number; last_error: string | null; external_id: string | null; doc_type: string; provider: string }>(
  "select action, status, attempts, last_error, external_id, doc_type, provider from public.integration_sends where doc_id = $1 order by action", [id]);
const claim = (t = alpha(), lease = 120) => svc<{ r: { blocked: string | null; unmapped?: string[]; send: Record<string, string | number | null> | null } }>(
  "select public.integration_claim_next($1, 'xero', $2) as r", [t.id, lease]).then((rows) => rows[0].r);
const record = (send: Record<string, unknown>, status: string, ext: string | null = null, error: string | null = null, retryAt: string | null = null) =>
  svc<{ r: { recorded: boolean } }>("select public.integration_record_result($1, $2, $3, $4, $5, $6, $7) as r",
    [send.id, send.claim, status, ext, ext ? `N-${ext}` : null, error, retryAt]).then((rows) => rows[0].r.recorded);
/** Claims until the queue is empty (or blocked), recording each as sent: tidies one company's queue between tests. */
async function drain(t = alpha()) {
  for (let i = 0; i < 50; i += 1) {
    const c = await claim(t);
    if (!c.send) return c;
    await record(c.send, "sent", `ext-${randomUUID()}`);
  }
  throw new Error("queue did not drain");
}
/** The company's two-step rule (033), set as the owner in replica mode, as tests/support/fixtures.ts does for tests about the rule. */
const requireMfa = (org: string, on: boolean) => withDb(async (db) => {
  await db.query("begin");
  await db.query("set local session_replication_role = replica");
  await db.query("update public.organizations set require_admin_mfa = $2 where id = $1", [org, on]);
  await db.query("commit");
});

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("off by default; who may connect; tokens are secret", () => {
  it("a company that is not connected queues nothing: issuing works as before and no send row is written", async () => {
    const id = await invoice();
    await issue(id);
    expect(await sends(id)).toEqual([]);
    expect((await q(user("admin"), "select public.integration_overview('xero') as r"))[0].r).toMatchObject({ status: "not_connected", counts: {} });
  });

  it("only an admin of the company starts a Connect; the state is single use, bound to that admin and company, and expires", async () => {
    for (const role of ["office", "workshop", "viewer"] as const) {
      expect(await refusal(user(role), "select public.integration_oauth_begin('xero', $1, $2)", [hash(), cipher()]), role).toMatchObject({ code: "42501" });
    }
    expect(await refusal(user("admin"), "select public.integration_oauth_begin('quickbooks', $1, $2)", [hash(), cipher()])).toMatchObject({ code: "22023" });
    // A plain verifier is refused: only the server's ciphertext is kept.
    expect(await refusal(user("admin"), "select public.integration_oauth_begin('xero', $1, 'plain-verifier-text')", [hash()])).toMatchObject({ code: "23514" });
    const state = hash();
    await q(user("admin"), "select public.integration_oauth_begin('xero', $1, $2)", [state, cipher()]);
    // Another admin, another company, or the wrong state: refused, and the state is not used up by them.
    expect(await svcRefusal("select public.integration_oauth_consume($1, $2, 'xero', $3)", [alpha().id, alpha().users.office.id, state])).toMatchObject({ code: "42501" });
    expect(await svcRefusal("select public.integration_oauth_consume($1, $2, 'xero', $3)", [beta().id, beta().users.admin.id, state])).toMatchObject({ code: "42501", hint: "oauth_state_invalid" });
    const used = await svc<{ r: { verifier_enc: string } }>("select public.integration_oauth_consume($1, $2, 'xero', $3) as r", [alpha().id, alpha().users.admin.id, state]);
    expect(used[0].r.verifier_enc).toMatch(/^v1\./);
    expect(await svcRefusal("select public.integration_oauth_consume($1, $2, 'xero', $3)", [alpha().id, alpha().users.admin.id, state])).toMatchObject({ hint: "oauth_state_invalid" });
    const stale = hash();
    await q(user("admin"), "select public.integration_oauth_begin('xero', $1, $2)", [stale, cipher()]);
    await owner("update public.integration_oauth_states set expires_at = now() - interval '1 second' where state_hash = $1", [stale]);
    expect(await svcRefusal("select public.integration_oauth_consume($1, $2, 'xero', $3)", [alpha().id, alpha().users.admin.id, stale])).toMatchObject({ hint: "oauth_state_invalid" });
  });

  it("the connection is stored for an active admin only, with ciphertext only; a Xero organisation is linked to one company", async () => {
    expect(await svcRefusal("select public.integration_store_connection($1, $2, 'xero', 't-x', 'X', null, $3, $4, now(), 1)",
      [alpha().id, alpha().users.office.id, cipher(), cipher()])).toMatchObject({ code: "42501" });
    // A plain token (a JWT) is never stored.
    expect(await svcRefusal("select public.integration_store_connection($1, $2, 'xero', 't-x', 'X', null, 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', $3, now(), 1)",
      [alpha().id, alpha().users.admin.id, cipher()])).toMatchObject({ code: "23514" });
    const tenant = await connect();
    alphaTenant = tenant;
    expect((await q(user("admin"), "select public.integration_overview('xero') as r"))[0].r).toMatchObject({ status: "connected", tenant_name: `${alpha().name} Xero` });
    // Beta can't link the same Xero organisation; alpha can't switch organisation without disconnecting first.
    expect(await svcRefusal("select public.integration_store_connection($1, $2, 'xero', $3, 'X', null, $4, $5, now(), 1)",
      [beta().id, beta().users.admin.id, tenant, cipher(), cipher()])).toMatchObject({ code: "23505", hint: "tenant_in_use" });
    expect(await svcRefusal("select public.integration_store_connection($1, $2, 'xero', 'other-tenant', 'X', null, $3, $4, now(), 1)",
      [alpha().id, alpha().users.admin.id, cipher(), cipher()])).toMatchObject({ code: "22023", hint: "disconnect_first" });
    const events = await owner<{ metadata: Record<string, unknown> }>("select metadata from security_audit.audit_log where organization_id = $1 and action = 'INTEGRATION_CONNECTED'", [alpha().id]);
    expect(events.at(-1)!.metadata).toMatchObject({ provider: "xero", tenant_id: tenant, by: alpha().users.admin.id });
  });

  it("nobody signed in reads the tokens or the OAuth states, through any path; only the company's admins read the rest", async () => {
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      for (const table of ["integration_secrets", "integration_oauth_states"]) {
        expect(await refusal(user(role), `select * from public.${table}`), `${role} ${table}`).toMatchObject({ code: "42501" });
      }
    }
    expect((await q(user("admin"), "select count(*)::int as n from public.integration_connections"))[0].n).toBe(1);
    for (const role of ["office", "workshop", "viewer"] as const) {
      for (const table of ["integration_connections", "integration_mappings", "integration_contacts", "integration_sends"]) {
        expect((await q(user(role), `select count(*)::int as n from public.${table}`))[0].n, `${role} ${table}`).toBe(0);
      }
      expect(await refusal(user(role), "select public.integration_overview('xero')"), role).toMatchObject({ code: "42501" });
    }
    expect((await q(user("admin", beta()), "select count(*)::int as n from public.integration_connections where organization_id = $1", [alpha().id]))[0].n).toBe(0);
    // No signed-in write path at all.
    expect(await refusal(user("admin"), "update public.integration_connections set status = 'disconnected' where organization_id = $1", [alpha().id])).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "insert into public.integration_sends (organization_id, provider, doc_type, doc_id, action) values ($1, 'xero', 'invoice', $2, 'create')", [alpha().id, randomUUID()])).toMatchObject({ code: "42501" });
    // The server's functions are not callable from the API: not the token lease, not the claim, not the document.
    for (const sql of ["select public.integration_token_lease($1, 'xero', gen_random_uuid(), 60)", "select public.integration_claim_next($1, 'xero', 60)",
      "select public.integration_unmapped($1, 'xero')", "select public.integration_document($1, 'invoice', gen_random_uuid())",
      "select public.integration_mark_needs_reconnect($1, 'xero', 'x')"]) {
      expect(await refusal(user("admin"), sql, [alpha().id]), sql).toMatchObject({ code: "42501" });
    }
    // The tokens never reach the audit log (the secrets table is not audited; no ciphertext in any row).
    const leaked = await owner<{ n: number }>(`select count(*)::int as n from security_audit.audit_log where organization_id = $1
      and (entity_table in ('integration_secrets', 'integration_oauth_states') or coalesce(new_data::text, '') ~ 'v1\\.[A-Za-z0-9_-]{8,}\\.' or coalesce(old_data::text, '') ~ 'v1\\.[A-Za-z0-9_-]{8,}\\.' or metadata::text ~ 'v1\\.[A-Za-z0-9_-]{8,}\\.')`, [alpha().id]);
    expect(leaked[0].n).toBe(0);
  });

  it("with the company's two-step rule on, an admin who has not passed it can't connect, disconnect, map or retry", async () => {
    await requireMfa(beta().id, true);
    try {
      for (const sql of ["select public.integration_oauth_begin('xero', md5(random()::text) || md5(random()::text), $1)",
        "select public.integration_disconnect('xero')", "select public.integration_set_mapping('xero', 'sales_account', null, '200', 'Sales')",
        "select public.integration_retry_send(gen_random_uuid())", "select public.integration_resolve_contact('xero', 'Acme', 'c-1')"]) {
        const params = sql.includes("$1") ? [cipher()] : [];
        expect(await refusal(user("admin", beta()), sql, params), sql).toMatchObject({ code: "42501", hint: "mfa_required" });
      }
    } finally {
      await requireMfa(beta().id, false);
    }
  });
});

describe("the queue: each document once, the gate, the claim", () => {
  it("issuing queues one create per document (keyed by its id); later status changes add nothing; a duplicate is refused", async () => {
    const id = await invoice();
    await issue(id);
    expect(await sends(id)).toMatchObject([{ action: "create", status: "pending", attempts: 0, doc_type: "invoice", provider: "xero" }]);
    await owner("update public.invoices set status = 'sent' where id = $1", [id]);
    await owner("update public.invoices set status = 'paid' where id = $1", [id]);
    expect(await sends(id)).toHaveLength(1);
    await expect(owner("insert into public.integration_sends (organization_id, provider, doc_type, doc_id, action) values ($1, 'xero', 'invoice', $2, 'create')",
      [alpha().id, id])).rejects.toMatchObject({ code: "23505" });
    // Beta is not connected: its issues queue nothing, and alpha's connection queues nothing of beta's.
    const other = await invoice(beta());
    await issue(other);
    expect(await sends(other)).toEqual([]);
  });

  it("through the app's own calls, as signed-in office staff: issue, credit and void queue their rows and work exactly as before", async () => {
    const header = { customer: "Acme Engineering Ltd", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" };
    const lines = [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }];
    const make = async () => (await q<{ id: string }>(user("office"), "select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as id",
      [JSON.stringify(header), JSON.stringify(lines)]))[0].id;
    const id = await make();
    const ref = (await q<{ r: string }>(user("office"), "select public.issue_invoice($1) as r", [id]))[0].r;
    expect(ref).toMatch(/^INV-/);
    expect(await sends(id)).toMatchObject([{ action: "create", status: "pending" }]);
    // The send row is written in the same transaction as the issue and audited as the person who issued.
    expect((await owner<{ actor_user_id: string }>("select actor_user_id from security_audit.audit_log where entity_table = 'integration_sends' and new_data ->> 'doc_id' = $1", [id]))[0].actor_user_id).toBe(alpha().users.office.id);
    const line = (await owner<{ id: string }>("select id from public.invoice_line_items where invoice_id = $1", [id]))[0].id;
    const credit = (await q<{ id: string }>(user("office"), "select public.create_credit_note($1, null, current_date, $2::jsonb) as id", [id, JSON.stringify([{ invoice_line_id: line, quantity: 1 }])]))[0].id;
    await q(user("office"), "select public.issue_credit_note($1)", [credit]);
    expect(await sends(credit)).toMatchObject([{ action: "create", status: "pending", doc_type: "credit_note" }]);
    // A second invoice voided through void_invoice (nothing paid or credited): its void follows its create.
    const other = await make();
    await q(user("office"), "select public.issue_invoice($1)", [other]);
    await q(user("office"), "select public.void_invoice($1, 'Raised against the wrong customer')", [other]);
    expect((await sends(other)).map((s) => s.action)).toEqual(["create", "void"]);
    // Office can't see the send log (admins only), and can't write it.
    expect((await q(user("office"), "select count(*)::int as n from public.integration_sends"))[0].n).toBe(0);
  });

  it("an import is never queued: not under the import's session setting, not a record the import wrote", async () => {
    const guc = await invoice();
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("select set_config('quoteflow.data_import', $1, true)", [alpha().id]);
      await db.query("update public.invoices set status = 'issued', invoice_ref = $2 where id = $1", [guc, `INV-IMP-${world.runId}`]);
      await db.query("commit");
    });
    expect(await sends(guc)).toEqual([]);
    const keyed = await invoice();
    const batch = (await owner<{ id: string }>(`insert into public.import_batches (organization_id, client_op_id, request_sha256, kinds, counts, result, status)
      values ($1, gen_random_uuid(), $2, '{invoices}', '{}', '{}', 'committed') returning id`, [alpha().id, hash()]))[0].id;
    await owner("insert into public.import_record_keys (organization_id, kind, match_key, record_id, batch_id) values ($1, 'invoices', $2, $3, $4)", [alpha().id, `k-${keyed}`, keyed, batch]);
    await issue(keyed);
    expect(await sends(keyed)).toEqual([]);
  });

  it("nothing is claimed until both account codes and every VAT rate the waiting documents use are mapped (admin only)", async () => {
    await drain().catch(() => undefined);
    const id = await invoice(alpha(), [{ unit_price: 100, vat_pct: 20 }, { unit_price: 10, vat_pct: 5 }, { unit_price: 0, quantity: 0, description: "Note only" }]);
    await issue(id);
    const blocked = await claim();
    expect(blocked.send).toBeNull();
    expect(blocked.blocked).toBe("unmapped");
    expect(blocked.unmapped).toEqual(expect.arrayContaining(["account:credit", "account:sales", "vat:20", "vat:5"]));
    for (const role of ["office", "workshop", "viewer"] as const) {
      expect(await refusal(user(role), "select public.integration_set_mapping('xero', 'tax_rate', '20', 'OUTPUT2', 'VAT 20')"), role).toMatchObject({ code: "42501" });
    }
    expect(await refusal(user("admin"), "select public.integration_set_mapping('xero', 'tax_rate', 'twenty', 'X', null)")).toMatchObject({ code: "22023" });
    await mapAll(alpha(), ["20"]);
    expect((await claim()).unmapped).toEqual(["vat:5"]);
    expect((await q<{ r: { unmapped: string[] } }>(user("admin"), "select public.integration_overview('xero') as r"))[0].r.unmapped).toEqual(["vat:5"]);
    await mapAll(alpha(), ["20", "5"]);
    // Older rows (queued by the tests above, waiting for the mappings) go first, oldest first.
    let got = await claim();
    expect(got.blocked).toBeNull();
    while (got.send && got.send.doc_id !== id) {
      await record(got.send, "sent", `ext-${randomUUID()}`);
      got = await claim();
    }
    expect(got.send).toMatchObject({ doc_id: id, action: "create", attempts: 1 });
    expect(await record(got.send!, "sent", "xero-inv-1")).toBe(true);
    expect(await sends(id)).toMatchObject([{ status: "sent", external_id: "xero-inv-1" }]);
    // A sent row is final: no second result, by the same claim or any other.
    expect(await record(got.send!, "failed", null, "late")).toBe(false);
    // Removing a mapping blocks the next send again.
    await q(user("admin"), "select public.integration_set_mapping('xero', 'tax_rate', '5', null, null)");
    const next = await invoice(alpha(), [{ unit_price: 1, vat_pct: 5 }]);
    await issue(next);
    expect((await claim()).unmapped).toEqual(["vat:5"]);
    await mapAll(alpha(), ["20", "5"]);
    await drain();
  });

  it("two senders never take the same row (FOR UPDATE SKIP LOCKED); a result only from the claim that holds the row", async () => {
    const a = await invoice();
    const b = await invoice();
    await issue(a);
    await issue(b);
    // Another sender holds a's row (a row lock, as a claim in flight holds it; a claim's own write also waits on the company's audit
    // chain lock, 077, so two claims commit one after the other): the next claim skips it and takes b, without waiting.
    await withDb(async (one) => {
      await one.query("begin");
      await one.query("select id from public.integration_sends where doc_id = $1 for update", [a]);
      const second = await claim();
      expect(second.send!.doc_id).toBe(b);
      await one.query("commit");
      const first = await claim();
      expect(first.send!.doc_id).toBe(a);
      expect(await record({ id: first.send!.id, claim: randomUUID() }, "sent", "x")).toBe(false);
      expect(await record(first.send!, "sent", "xero-a")).toBe(true);
      expect(await record(second.send!, "failed", null, "Xero said: ValidationException\nContact is archived")).toBe(true);
    });
    const failed = await owner<{ last_error: string }>("select last_error from public.integration_sends where status = 'failed' and organization_id = $1", [alpha().id]);
    expect(failed.at(-1)!.last_error).toBe("Xero said: ValidationException Contact is archived");
  });

  it("a claim that runs out becomes needs_check; an admin's retry queues it again; office can't", async () => {
    await drain();
    const id = await invoice();
    await issue(id);
    const got = await claim(alpha(), 10);
    await owner("update public.integration_sends set claimed_until = now() - interval '1 second' where id = $1", [got.send!.id]);
    expect((await claim()).send).toBeNull();
    const [row] = await owner<{ id: string; status: string; last_error: string }>("select id, status, last_error from public.integration_sends where doc_id = $1", [id]);
    expect(row).toMatchObject({ status: "needs_check", last_error: expect.stringMatching(/check Xero/) });
    // The late definite answer of that claim is still taken.
    expect(await record(got.send!, "failed", null, "Xero refused it")).toBe(true);
    expect(await refusal(user("office"), "select public.integration_retry_send($1)", [row.id])).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin", beta()), "select public.integration_retry_send($1)", [row.id])).toMatchObject({ code: "P0002" });
    await q(user("admin"), "select public.integration_retry_send($1)", [row.id]);
    expect(await refusal(user("admin"), "select public.integration_retry_send($1)", [row.id])).toMatchObject({ hint: "not_retryable" });
    const again = await claim();
    expect(again.send).toMatchObject({ id: row.id, attempts: 2 });
    await record(again.send!, "sent", "xero-retried");
    expect((await owner("select count(*)::int as n from security_audit.audit_log where action = 'INTEGRATION_SEND_RETRY' and entity_id = $1", [row.id]))[0].n).toBe(1);
  });

  it("the automatic send after an issue claims only that document's first attempt: never another document, never a retry", async () => {
    await drain();
    const [mine, other] = [await invoice(), await invoice()];
    await issue(other);
    await issue(mine);
    const only = (id: string) => svc<{ r: { send: Record<string, unknown> | null } }>("select public.integration_claim_next($1, 'xero', 120, 'invoice', $2) as r", [alpha().id, id]).then((r) => r[0].r);
    const got = await only(mine);
    expect(got.send).toMatchObject({ doc_id: mine, attempts: 1 });
    await record(got.send!, "pending", null, "timeout; Xero has no copy", new Date(Date.now() - 1000).toISOString());
    // Its retry is due, but only an admin's Send now (or the sweep) sends it again.
    expect((await only(mine)).send).toBeNull();
    expect((await claim()).send).toMatchObject({ doc_id: other });
    await drain();
  });

  it("voids: a void follows the create; voided before it was ever sent, neither goes; credit notes queue once", async () => {
    await drain();
    const sent = await invoice();
    await issue(sent);
    const c1 = await claim();
    await record(c1.send!, "sent", "xero-sent-1");
    await voidIt(sent);
    const v = await claim();
    expect(v.send).toMatchObject({ doc_id: sent, action: "void", external_id: "xero-sent-1" });
    await record(v.send!, "sent", "xero-sent-1");
    expect((await sends(sent)).map((s) => [s.action, s.status])).toEqual([["create", "sent"], ["void", "sent"]]);

    const never = await invoice();
    await issue(never);
    await voidIt(never);
    expect((await claim()).send).toBeNull();
    expect((await sends(never)).map((s) => [s.action, s.status])).toEqual([["create", "skipped"], ["void", "skipped"]]);

    // A void waits while its create's outcome is unknown.
    const unsure = await invoice();
    await issue(unsure);
    const u = await claim();
    await record(u.send!, "needs_check", null, "timeout");
    await voidIt(unsure);
    expect((await claim()).send).toBeNull();
    expect((await sends(unsure)).map((s) => [s.action, s.status])).toEqual([["create", "needs_check"], ["void", "pending"]]);

    // A credit note: issued once, queued once.
    const inv = (await owner<{ id: string }>("select id from public.invoices where id = $1", [sent]))[0].id;
    const credit = (await owner<{ id: string }>(`insert into public.credit_notes (organization_id, invoice_id, customer, status, subtotal, vat, total)
      values ($1, $2, 'Acme Engineering Ltd', 'draft', 10, 2, 12) returning id`, [alpha().id, inv]))[0].id;
    await owner(`insert into public.credit_note_lines (organization_id, credit_note_id, description, quantity, unit_price, vat_pct, vat_amount)
      values ($1, $2, 'Returned part', 1, 10, 20, 2)`, [alpha().id, credit]);
    await owner("update public.credit_notes set status = 'issued', credit_ref = $2, issued_at = now() where id = $1", [credit, `CRD-X84-${world.runId}`]);
    expect(await sends(credit)).toMatchObject([{ action: "create", status: "pending", doc_type: "credit_note" }]);
  });
});

describe("the refresh lease, disconnect and contacts", () => {
  it("one holder at a time: the second caller waits on the row lock and gets nothing; only the holder stores; released, it is free", async () => {
    const [h1, h2] = [randomUUID(), randomUUID()];
    await withDb(async (one: Client) => {
      await one.query("begin");
      await one.query("set local role service_role");
      const first = (await one.query("select public.integration_token_lease($1, 'xero', $2, 60) as r", [alpha().id, h1])).rows[0].r;
      expect(first.refresh_token_enc).toMatch(/^v1\./);
      // The second lease blocks on the first's row lock until it commits, then sees the first's lease and gets nothing.
      const second = svc<{ r: unknown }>("select public.integration_token_lease($1, 'xero', $2, 60) as r", [alpha().id, h2]);
      await new Promise((r) => setTimeout(r, 300));
      const waiting = await owner<{ n: number }>("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%integration_token_lease%'");
      expect(waiting[0].n).toBe(1);
      await one.query("commit");
      expect((await second)[0].r).toBeNull();
    });
    const next = cipher();
    expect((await svc<{ r: boolean }>("select public.integration_token_store($1, 'xero', $2, $3, $4, now() + interval '30 minutes', 1) as r", [alpha().id, h2, cipher(), cipher()]))[0].r).toBe(false);
    expect((await svc<{ r: boolean }>("select public.integration_token_store($1, 'xero', $2, $3, $4, now() + interval '30 minutes', 1) as r", [alpha().id, h1, next, cipher()]))[0].r).toBe(true);
    await svc("select public.integration_token_release($1, 'xero', $2)", [alpha().id, h1]);
    const taken = (await svc<{ r: { refresh_token_enc: string } }>("select public.integration_token_lease($1, 'xero', $2, 60) as r", [alpha().id, h2]))[0].r;
    expect(taken.refresh_token_enc).toBe(next);
    // An expired lease is taken over; the old holder can then no longer store.
    await owner("update public.integration_secrets set lease_until = now() - interval '1 second' where organization_id = $1", [alpha().id]);
    expect((await svc<{ r: unknown }>("select public.integration_token_lease($1, 'xero', $2, 60) as r", [alpha().id, h1]))[0].r).not.toBeNull();
    expect((await svc<{ r: boolean }>("select public.integration_token_store($1, 'xero', $2, $3, null, null, 1) as r", [alpha().id, h2, cipher()]))[0].r).toBe(false);
    await svc("select public.integration_token_release($1, 'xero', $2)", [alpha().id, h1]);
    // A refused refresh token pauses sending until an admin connects again (audited once).
    await svc("select public.integration_mark_needs_reconnect($1, 'xero', 'invalid_grant')", [alpha().id]);
    await svc("select public.integration_mark_needs_reconnect($1, 'xero', 'invalid_grant')", [alpha().id]);
    expect((await claim()).blocked).toBe("needs_reconnect");
    expect((await owner("select count(*)::int as n from security_audit.audit_log where organization_id = $1 and action = 'INTEGRATION_NEEDS_RECONNECT'", [alpha().id]))[0].n).toBe(1);
  });

  it("contacts: a match is kept; a problem never guesses and is never replaced by the server; an admin chooses", async () => {
    const rec = (name: string, ext: string | null, by: string | null, problem: string | null) =>
      svc<{ r: Record<string, unknown> }>("select public.integration_contact_record($1, 'xero', $2, $3, $4, $5) as r", [alpha().id, name, ext, by, problem]).then((r) => r[0].r);
    expect(await rec("  Exact Ltd ", "c-1", "exact_name", null)).toMatchObject({ state: "ok", external_contact_id: "c-1", matched_by: "exact_name" });
    expect(await rec("Exact Ltd", "c-2", "created", null)).toMatchObject({ external_contact_id: "c-1" });
    expect(await rec("Twice Ltd", null, null, "2 contacts in Xero are called Twice Ltd")).toMatchObject({ state: "problem", external_contact_id: null });
    expect(await refusal(user("office"), "select public.integration_resolve_contact('xero', 'Twice Ltd', 'c-9')")).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin", beta()), "select public.integration_resolve_contact('xero', 'Twice Ltd', 'c-9')")).toMatchObject({ code: "P0002" });
    await q(user("admin"), "select public.integration_resolve_contact('xero', 'Twice Ltd', 'c-9')");
    expect(await rec("Twice Ltd", null, null, "still two")).toMatchObject({ state: "ok", external_contact_id: "c-9", matched_by: "chosen" });
    expect(await refusal(user("admin"), "select public.integration_resolve_contact('xero', 'Exact Ltd', 'c-9')")).toMatchObject({ code: "P0002" });
  });

  it("disconnect: admin only; the tokens go, anything not yet sent is skipped, the log stays; audited", async () => {
    const pending = await invoice();
    await issue(pending);
    expect(await refusal(user("office"), "select public.integration_disconnect('xero')")).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin", beta()), "select public.integration_disconnect('xero')")).toMatchObject({ code: "P0002", hint: "not_connected" });
    await disconnect();
    expect((await owner("select count(*)::int as n from public.integration_secrets where organization_id = $1", [alpha().id]))[0].n).toBe(0);
    expect(await sends(pending)).toMatchObject([{ status: "skipped", last_error: expect.stringMatching(/Disconnected/) }]);
    expect((await owner("select count(*)::int as n from public.integration_sends where organization_id = $1 and status = 'sent'", [alpha().id]))[0].n).toBeGreaterThan(0);
    expect((await claim()).blocked).toBe("disconnected");
    const issuedAfter = await invoice();
    await issue(issuedAfter);
    expect(await sends(issuedAfter)).toEqual([]);
    expect((await owner("select count(*)::int as n from security_audit.audit_log where organization_id = $1 and action = 'INTEGRATION_DISCONNECTED'", [alpha().id]))[0].n).toBe(1);
    // Once disconnected, the same Xero organisation can be linked to another company.
    await connect(beta(), alphaTenant);
    expect((await q(user("admin", beta()), "select public.integration_overview('xero') as r"))[0].r).toMatchObject({ status: "connected" });
    await disconnect(beta());
  });

  it("connected again to a different organisation: the old contact matches go; a void of an invoice sent to the old one is skipped, never left waiting", async () => {
    const contacts = () => owner<{ n: number }>("select count(*)::int as n from public.integration_contacts where organization_id = $1", [alpha().id]).then((r) => r[0].n);
    expect(await contacts()).toBeGreaterThan(0);
    const [old] = await owner<{ doc_id: string }>(`select s.doc_id from public.integration_sends s join public.invoices i on i.id = s.doc_id
      where s.organization_id = $1 and s.action = 'create' and s.status = 'sent' and s.tenant_id = $2 and i.status not in ('void', 'cancelled') limit 1`, [alpha().id, alphaTenant]);
    await connect(alpha(), `tenant-other-${randomUUID()}`);
    expect(await contacts()).toBe(0);
    await voidIt(old.doc_id);
    expect((await claim()).send).toBeNull();
    expect((await sends(old.doc_id)).map((s) => [s.action, s.status])).toEqual([["create", "sent"], ["void", "skipped"]]);
    expect((await sends(old.doc_id))[1].last_error).toMatch(/another Xero organisation/);
    // Reconnecting to the same organisation keeps the matches.
    await svc("select public.integration_contact_record($1, 'xero', 'Kept Ltd', 'c-k', 'exact_name', null)", [alpha().id]);
    const same = (await owner<{ tenant_id: string }>("select tenant_id from public.integration_connections where organization_id = $1", [alpha().id]))[0].tenant_id;
    await disconnect();
    await connect(alpha(), same);
    expect(await contacts()).toBe(1);
  });
});

describe("each line's VAT key (the one place they are worked out)", () => {
  const doc = (id: string, type = "invoice", org = alpha().id) =>
    svc<{ r: { lines: Array<{ vat_key: string | null; net: number; vat: number; text_only: boolean; carriage?: boolean }>; subtotal: number; number: string; voided: boolean } }>(
      "select public.integration_document($1, $2, $3) as r", [org, type, id]).then((r) => r[0].r);

  it("rates, exempt, text-only lines and carriage on a VAT-charging invoice", async () => {
    const id = await invoice(alpha(), [{ unit_price: 100, vat_pct: 20 }, { unit_price: 10, vat_pct: 5, quantity: 3 }, { unit_price: 7, vat_pct: 0 },
      { unit_price: 9.99, vat_exempt: true }, { unit_price: 33.333 as number, vat_pct: 17.5 }, { unit_price: 0, quantity: 0, description: "Text" }],
      { carriage: 15, carriage_vat: true });
    const d = await doc(id);
    expect(d.lines.map((l) => l.vat_key)).toEqual(["20", "5", "0", "exempt", "17.5", null, "20"]);
    expect(d.lines.map((l) => Number(l.vat))).toEqual([20, 1.5, 0, 0, 5.83, 0, 3]);
    expect(d.lines[5].text_only).toBe(true);
    expect(d.lines[6].carriage).toBe(true);
    // Carriage without VAT (question 5's default): 'no_vat'.
    const noCarriageVat = await invoice(alpha(), [{ unit_price: 1 }], { carriage: 5, carriage_vat: false });
    expect((await doc(noCarriageVat)).lines.map((l) => l.vat_key)).toEqual(["20", "no_vat"]);
  });

  it("'no_vat' when the invoice charges no VAT, or the company is not VAT registered; another company's document is not returned", async () => {
    const off = await invoice(alpha(), [{ unit_price: 50, vat_pct: 20 }, { unit_price: 5, vat_exempt: true }], { vat_enabled: false });
    expect((await doc(off)).lines.map((l) => [l.vat_key, Number(l.vat)])).toEqual([["no_vat", 0], ["no_vat", 0]]);
    const reg = await invoice(beta(), [{ unit_price: 50, vat_pct: 20 }], { carriage: 4, carriage_vat: true });
    await owner(`insert into public.organization_settings (organization_id, company_profile) values ($1, '{"vatRegistered": false}')
                 on conflict (organization_id) do update set company_profile = coalesce(public.organization_settings.company_profile, '{}'::jsonb) || '{"vatRegistered": false}'`, [beta().id]);
    expect((await doc(reg, "invoice", beta().id)).lines.map((l) => l.vat_key)).toEqual(["no_vat", "no_vat"]);
    expect(await doc(reg, "invoice", alpha().id)).toBeNull();
  });
});
