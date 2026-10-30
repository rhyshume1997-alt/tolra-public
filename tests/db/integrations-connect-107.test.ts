/**
 * Integrations connect (migration 107, E2/E7). Proves in SQL, as PostgREST runs it (role authenticated with the JWT claims, or the
 * service role for the server's own calls):
 *   - Microsoft 365 as a connection provider: Connect started by the company's admin only (integration_oauth_start), completed through
 *     084's consume/store, shown by 084's overview; issuing an invoice in a company connected to Microsoft 365 queues Xero only, never fails;
 *   - the accountant's link: created by the company's admin only, kept as a hash, single use (a second open is refused), refused once
 *     expired; its state is completed by the invite callback only, once; the tables are unreadable through the API;
 *   - app-level credentials: a company admin can neither set, remove nor list them; the table is unreadable through the API.
 * The same checks with the platform owner, support sessions and the two-step rule: tests/scripts/integrations_connect_107_proof.sql.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, q, refusal } from "./time-support";

let world: SyntheticWorld;
const alpha = () => world.tenants.alpha;
const user = (role: "admin" | "office" | "workshop" | "viewer", t = alpha()): Who => ({ id: t.users[role].id });
const cipher = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}`;
const hash = () => randomBytes(32).toString("hex");

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

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("Microsoft 365 connect", () => {
  it("only the company's admin starts it; office and viewer are refused; an unknown provider is refused", async () => {
    expect(await refusal(user("office"), "select public.integration_oauth_start('microsoft', $1, $2)", [hash(), cipher()])).toMatchObject({ code: "42501" });
    expect(await refusal(user("viewer"), "select public.integration_oauth_start('microsoft', $1, $2)", [hash(), cipher()])).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "select public.integration_oauth_start('gmail', $1, $2)", [hash(), cipher()])).toMatchObject({ code: "22023" });
  });

  it("started by the admin, completed by the server through 084's consume and store; the overview shows the mailbox", async () => {
    const state = hash();
    await q(user("admin"), "select public.integration_oauth_start('microsoft', $1, $2) as id", [state, cipher()]);
    await svc("select public.integration_oauth_consume($1, $2, 'microsoft', $3) as r", [alpha().id, alpha().users.admin.id, state]);
    await svc("select public.integration_store_connection($1, $2, 'microsoft', $3, $4, null, $5, $6, now() + interval '1 hour', 1) as r",
      [alpha().id, alpha().users.admin.id, `oid-${randomUUID()}`, `office.${world.runId}@example.test`, cipher(), cipher()]);
    const [{ r }] = await q<{ r: { status: string; tenant_name: string } }>(user("admin"), "select public.integration_overview('microsoft') as r");
    expect(r).toMatchObject({ status: "connected", tenant_name: `office.${world.runId}@example.test` });
    // The state is single use.
    expect(await svcRefusal("select public.integration_oauth_consume($1, $2, 'microsoft', $3)", [alpha().id, alpha().users.admin.id, state])).toMatchObject({ hint: "oauth_state_invalid" });
  });

  it("issuing an invoice in a company connected to Microsoft 365 queues no Microsoft row and doesn't fail", async () => {
    const id = (await owner<{ id: string }>(`insert into public.invoices (organization_id, customer, status, subtotal, vat, total, vat_enabled, due_date, invoice_date)
      values ($1, 'Acme', 'draft', 0, 0, 0, true, '2026-11-30', '2026-10-30') returning id`, [alpha().id]))[0].id;
    await owner("update public.invoices set status = 'issued', invoice_ref = $2, issued_at = now() where id = $1", [id, `INV-107-${world.runId}`]);
    expect(await owner("select provider from public.integration_sends where doc_id = $1 and provider <> 'xero'", [id])).toEqual([]);
  });

  it("disconnect (084's function) deletes the mailbox's tokens", async () => {
    await q(user("admin"), "select public.integration_disconnect('microsoft') as r");
    expect(await owner("select 1 from public.integration_secrets where organization_id = $1 and provider = 'microsoft'", [alpha().id])).toEqual([]);
  });
});

describe("the accountant's connect link", () => {
  it("created by the company's admin only, for Xero only; the tables are not readable through the API", async () => {
    expect(await refusal(user("office"), "select public.integration_invite_create('xero', $1)", [hash()])).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "select public.integration_invite_create('microsoft', $1)", [hash()])).toMatchObject({ code: "22023" });
    expect(await refusal(user("admin"), "select count(*) from public.integration_connect_invites")).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "select public.integration_invite_redeem($1, $2, $3)", [hash(), hash(), cipher()])).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "select public.integration_oauth_consume_invite('xero', $1)", [hash()])).toMatchObject({ code: "42501" });
  });

  it("opens once: a state bound to the company and the admin; a second open is refused; the invite callback consumes it once", async () => {
    const token = hash();
    const [{ r }] = await q<{ r: { expires_at: string } }>(user("admin"), "select public.integration_invite_create('xero', $1) as r", [token]);
    expect(Date.parse(r.expires_at) - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    const state = hash();
    const [{ o }] = await svc<{ o: { organization_id: string } }>("select public.integration_invite_redeem($1, $2, $3) as o", [token, state, cipher()]);
    expect(o.organization_id).toBe(alpha().id);
    expect(await svcRefusal("select public.integration_invite_redeem($1, $2, $3)", [token, hash(), cipher()])).toMatchObject({ hint: "invite_invalid" });
    const [{ c }] = await svc<{ c: { organization_id: string; user_id: string } | null }>("select public.integration_oauth_consume_invite('xero', $1) as c", [state]);
    expect(c).toMatchObject({ organization_id: alpha().id, user_id: alpha().users.admin.id });
    const [{ again }] = await svc<{ again: unknown }>("select public.integration_oauth_consume_invite('xero', $1) as again", [state]);
    expect(again).toBeNull();
  });

  it("an expired link is refused; an admin's own Connect state is never accepted by the invite callback", async () => {
    const token = hash();
    await owner(`insert into public.integration_connect_invites (organization_id, provider, token_hash, created_by, created_at, expires_at)
                 values ($1, 'xero', $2, $3, now() - interval '25 hours', now() - interval '1 hour')`, [alpha().id, token, alpha().users.admin.id]);
    expect(await svcRefusal("select public.integration_invite_redeem($1, $2, $3)", [token, hash(), cipher()])).toMatchObject({ hint: "invite_invalid" });
    const state = hash();
    await q(user("admin"), "select public.integration_oauth_begin('xero', $1, $2) as id", [state, cipher()]);
    const [{ c }] = await svc<{ c: unknown }>("select public.integration_oauth_consume_invite('xero', $1) as c", [state]);
    expect(c).toBeNull();
  });

  it("no token hash in the audit log", async () => {
    expect(await owner("select 1 from security_audit.audit_log where entity_table = 'integration_connect_invites' and metadata ? 'token_hash'")).toEqual([]);
  });
});

describe("app-level credentials: the platform owner's only", () => {
  it("a company admin can't save, remove or list them, and nobody signed in reads the table", async () => {
    expect(await refusal(user("admin"), "select public.integration_app_credentials_save('xero', 'id', $1, 'abcd', null, 1)", [cipher()])).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "select public.integration_app_credentials_remove('xero')")).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "select public.integration_app_credentials_list()")).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "select count(*) from public.integration_app_credentials")).toMatchObject({ code: "42501" });
  });
});
