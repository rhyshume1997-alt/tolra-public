/**
 * W-F3 (database half), on a disposable PG16 (migrations 000-137 + releases 138-147):
 *   1. the Microsoft connection state the setup card shows (integration_overview, the rpc the card calls) is each company's own:
 *      company A sees only A's mailbox, B only B's, a company with none sees "not connected", and only an admin may ask. The wider
 *      Microsoft isolation (tokens, mailbox_in_use, sending, polling) is W-M's tests/db/wm-ms-isolation.test.ts and is not repeated here.
 *   2. the Resend test-send audit row (exactly what app/api/integrations/resend/test-send/route.ts passes to write_audit): written by an
 *      admin for their own company with ids and codes only (no address, subject or text in the stored event), refused for a role that may
 *      not send, and never visible under another company.
 * Plain SQL with synthetic rows and forged session claims, as 095's test.
 */
import { randomUUID } from "node:crypto";

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
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `F3 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-f3-${label}-${counter}`]);
  return id;
}
async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}
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
async function code(db: Client, sql: string, args: unknown[]) {
  await db.query("savepoint s");
  try {
    const r = await db.query(sql, args);
    await db.query("release savepoint s");
    return { ok: true as const, rows: r.rows };
  } catch (error) {
    await db.query("rollback to savepoint s");
    return { ok: false as const, code: (error as { code?: string }).code };
  }
}

const W = { A: "", B: "", C: "", adminA: person("admin-a"), officeA: person("office-a"), viewerA: person("viewer-a"), adminB: person("admin-b"), adminC: person("admin-c") };
const MAILBOX_A = `shop-a.${run}@example.test`;
const MAILBOX_B = `shop-b.${run}@example.test`;

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a"); W.B = await makeOrg(db, "b"); W.C = await makeOrg(db, "c");
    await member(db, W.A, W.adminA, "admin"); await member(db, W.A, W.officeA, "office"); await member(db, W.A, W.viewerA, "viewer");
    await member(db, W.B, W.adminB, "admin"); await member(db, W.C, W.adminC, "admin");
    await db.query(`insert into public.integration_connections (organization_id, provider, status, tenant_id, tenant_name, connected_at)
                    values ($1, 'microsoft', 'connected', $2, $3, now()), ($4, 'microsoft', 'needs_reconnect', $5, $6, now())`,
      [W.A, `tid-a-${run}`, MAILBOX_A, W.B, `tid-b-${run}`, MAILBOX_B]);
  });
});
afterAll(async () => { await destroySyntheticWorld(run); });

const overview = (p: Person) => as(p, async (db) => (await db.query<{ o: Record<string, unknown> }>("select public.integration_overview('microsoft') as o")).rows[0].o);

describe("the Microsoft connection state the card shows is each company's own", () => {
  it("A sees its own mailbox as connected, B its own as needing reconnect, C (none) as not connected", async () => {
    expect(await overview(W.adminA)).toMatchObject({ status: "connected", tenant_name: MAILBOX_A });
    expect(await overview(W.adminB)).toMatchObject({ status: "needs_reconnect", tenant_name: MAILBOX_B });
    expect(await overview(W.adminC)).toMatchObject({ status: "not_connected", tenant_name: null, connected_at: null });
  });
  it("nobody's answer names another company's mailbox", async () => {
    for (const [p, other] of [[W.adminA, MAILBOX_B], [W.adminB, MAILBOX_A], [W.adminC, MAILBOX_A], [W.adminC, MAILBOX_B]] as const) {
      expect(JSON.stringify(await overview(p))).not.toContain(other);
    }
  });
  it("only an admin may ask (office and viewer: 42501)", async () => {
    for (const p of [W.officeA, W.viewerA]) {
      expect(await as(p, (db) => code(db, "select public.integration_overview('microsoft')", []))).toMatchObject({ ok: false, code: "42501" });
    }
  });
  it("disconnecting A changes A's answer and leaves B's alone", async () => {
    await withDb((db) => db.query("update public.integration_connections set status = 'disconnected' where organization_id = $1 and provider = 'microsoft'", [W.A]));
    expect(await overview(W.adminA)).toMatchObject({ status: "disconnected" });
    expect(await overview(W.adminB)).toMatchObject({ status: "needs_reconnect", tenant_name: MAILBOX_B });
  });
});

// Exactly the arguments the route sends.
const routeAudit = (org: string, outcome: string) => ["SEND", "email_history", org, null, null, JSON.stringify({ channel: "resend", purpose: "test_send", outcome }), null, null];
const WRITE = "select public.write_audit($1, $2, $3, $4, $5, $6, $7, $8)";
const rows = (org: string) => withDb(async (db) => (await db.query<{ action: string; entity_table: string; entity_id: string; actor_user_id: string; organization_id: string; old_data: unknown; new_data: unknown; metadata: Record<string, unknown>; ip_address: unknown; user_agent: unknown }>(
  "select action, entity_table, entity_id, actor_user_id, organization_id, old_data, new_data, metadata, ip_address, user_agent from security_audit.audit_log where organization_id = $1 and metadata ->> 'purpose' = 'test_send' order by created_at, id", [org])).rows);

describe("the Resend test-send audit row", () => {
  it("an admin records it for their own company: action, company, outcome code, nothing else", async () => {
    for (const outcome of ["accepted", "failed", "unknown"]) {
      expect(await as(W.adminA, (db) => code(db, WRITE, routeAudit(W.A, outcome)))).toMatchObject({ ok: true });
    }
    const stored = await rows(W.A);
    expect(stored).toHaveLength(3);
    for (const r of stored) {
      expect(r).toMatchObject({ action: "SEND", entity_table: "email_history", entity_id: W.A, organization_id: W.A, actor_user_id: W.adminA.id, old_data: null, new_data: null, ip_address: null, user_agent: null });
    }
    expect(stored.map((r) => r.metadata)).toEqual(["accepted", "failed", "unknown"].map((outcome) => ({ channel: "resend", purpose: "test_send", outcome, source: "write_audit" })));
    // No recipient address, subject or text anywhere in the event's own fields (the actor column is every audit row's "who").
    const flat = JSON.stringify(stored.map(({ metadata, old_data, new_data, entity_id }) => ({ metadata, old_data, new_data, entity_id })));
    for (const forbidden of ["@", "Tolra test e-mail", "This is a test e-mail"]) expect(flat).not.toContain(forbidden);
  });
  it("is the caller's company's row: B's admin writing for B leaves A's rows alone, and sees none of A's", async () => {
    expect(await as(W.adminB, (db) => code(db, WRITE, routeAudit(W.B, "accepted")))).toMatchObject({ ok: true });
    expect(await rows(W.B)).toHaveLength(1);
    expect(await rows(W.A)).toHaveLength(3);
    expect((await rows(W.B))[0]).toMatchObject({ organization_id: W.B, actor_user_id: W.adminB.id });
  });
  it("a viewer may not record it (42501), and nothing is stored", async () => {
    expect(await as(W.viewerA, (db) => code(db, WRITE, routeAudit(W.A, "accepted")))).toMatchObject({ ok: false, code: "42501" });
    expect(await rows(W.A)).toHaveLength(3);
  });
});
