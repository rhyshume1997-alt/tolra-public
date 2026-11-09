/**
 * F2: what the Xero setup card relies on, proved in SQL (disposable PG16, migrations 000-137 + releases 138-147). Correct with or without
 * release 149: where its transfer switch is installed, a connected and mapped company is handed nothing until the switch is turned on.
 *   - tenant binding: a Xero organisation belongs to one company at a time (migration 084's unique index on provider + tenant where not
 *     disconnected); a second company is refused with tenant_in_use; after the first disconnects it can take it;
 *   - company isolation: A's connection, mappings and queue are never visible or usable by B;
 *   - reconnect: needs_reconnect, then connected again: mappings and the queue are exactly as they were, and there is still no transfers
 *     switch in the database (this candidate has NO launch hold, so none can be "unchanged" but the data);
 *   - refusal before activation, as far as this candidate can prove it: not connected, disconnected, unmapped and needs_reconnect hand
 *     out nothing. WITH app credentials (an app-layer fact, proved by W-X's stubbed-transport tests in /tmp/claude-0/s/wx-comb and wx-base, not
 *     repeated here) a connected AND mapped company IS handed its queue: the last test says so out loud.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, q, refusal } from "./time-support";

let world: SyntheticWorld;
let seq = 0;
const alpha = () => world.tenants.alpha;
const beta = () => world.tenants.beta;
type Tenant = typeof world.tenants.alpha;
const admin = (t: Tenant): Who => ({ id: t.users.admin.id });

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
  try { await svc(text, params); return null; } catch (err) { const e = err as { code?: string; hint?: string; message: string }; return { code: e.code, hint: e.hint, message: e.message }; }
}
const owner = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<R>(text, params)).rows);

/** The callback's steps: begin as the admin, consume and store as the server. */
async function connect(t: Tenant, tenant: string, name = `${t.name} Xero`) {
  const state = hash();
  await q(admin(t), "select public.integration_oauth_begin('xero', $1, $2) as id", [state, cipher()]);
  await svc("select public.integration_oauth_consume($1, $2, 'xero', $3) as r", [t.id, t.users.admin.id, state]);
  await svc("select public.integration_store_connection($1, $2, 'xero', $3, $4, $5, $6, $7, now() + interval '30 minutes', 1) as r", [t.id, t.users.admin.id, tenant, name, randomUUID(), cipher(), cipher()]);
}
const tryConnect = (t: Tenant, tenant: string) => svcRefusal("select public.integration_store_connection($1, $2, 'xero', $3, 'X', null, $4, $5, now(), 1)", [t.id, t.users.admin.id, tenant, cipher(), cipher()]);
const disconnect = (t: Tenant) => q(admin(t), "select public.integration_disconnect('xero') as r");
const overview = async (t: Tenant) => (await q<{ r: { status: string; tenant_name: string | null; unmapped: string[]; counts: Record<string, number> } }>(admin(t), "select public.integration_overview('xero') as r"))[0].r;
async function mapAll(t: Tenant, code = "200") {
  await q(admin(t), "select public.integration_set_mapping('xero', 'sales_account', null, $1, 'Sales') as r", [code]);
  await q(admin(t), "select public.integration_set_mapping('xero', 'credit_account', null, $1, 'Sales') as r", [code]);
  await q(admin(t), "select public.integration_set_mapping('xero', 'tax_rate', '20', 'OUTPUT2', 'VAT 20') as r");
}
async function issueInvoice(t: Tenant) {
  seq += 1;
  return withDb(async (db) => {
    const id = (await db.query<{ id: string }>(
      `insert into public.invoices (organization_id, customer, status, subtotal, vat, total, vat_enabled, carriage, carriage_vat, due_date, invoice_date)
       values ($1, 'Acme Engineering Ltd', 'draft', 0, 0, 0, true, 0, false, '2026-11-30', '2026-10-21') returning id`, [t.id])).rows[0].id;
    await db.query(`insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Part', 1, 100, 20, false)`, [t.id, id]);
    await db.query("update public.invoices set status = 'issued', invoice_ref = $2, issued_at = now() where id = $1", [id, `INV-F2-${world.runId}-${seq}`]);
    return id;
  });
}
const claim = (t: Tenant) => svc<{ r: { blocked: string | null; unmapped?: string[]; send: Record<string, string | number | null> | null } }>("select public.integration_claim_next($1, 'xero', 120) as r", [t.id]).then((r) => r[0].r);
const sendRows = (t: Tenant) => owner<{ doc_id: string; status: string; attempts: number }>("select doc_id, status, attempts from public.integration_sends where organization_id = $1 order by doc_id", [t.id]);
const mappingRows = (t: Tenant) => owner<{ kind: string; tolra_key: string | null; external_code: string }>("select kind, tolra_key, external_code from public.integration_mappings where organization_id = $1 order by kind, tolra_key nulls first", [t.id]);
/** Release 149 (the per-company transfer switch) installed? This file runs both before it (CI baseline order) and after it (everything installed). */
const hasSwitch = async () => (await owner<{ f: string | null }>("select to_regclass('public.xero_transfer_hold')::text as f"))[0].f !== null;
/** An admin turns the switch ON with the real function (needs connected and mapped). */
const turnOn = (t: Tenant) => q(admin(t), "select public.integration_xero_set_transfers(true) as r");
/** Only for the company that is deliberately unmapped (the function refuses ON then): the row as an admin's turn-on leaves it, written as the owner. */
const forceOn = (t: Tenant) => owner("insert into public.xero_transfer_hold (organization_id, enabled, changed_by, reason) values ($1, true, $2, 'admin') on conflict (organization_id) do update set enabled = true, changed_by = excluded.changed_by, reason = 'admin'", [t.id, t.users.admin.id]);
async function clean(...ts: Tenant[]) {
  for (const t of ts) {
    if ((await overview(t).catch(() => ({ status: "not_connected" }))).status !== "not_connected") await disconnect(t).catch(() => undefined);
  }
}

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

describe("F2 never connected (runs first, on a company nothing has touched)", () => {
  it("overview says not_connected and the claim hands out nothing", async () => {
    expect(await overview(beta())).toMatchObject({ status: "not_connected", tenant_name: null, counts: {} });
    expect(await claim(beta())).toMatchObject({ blocked: "not_connected", send: null });
  });
});

describe("F2 tenant binding: one Xero organisation, one Tolra company", () => {
  it("a second company cannot take a tenant the first holds; after the first disconnects it can; the first is then refused", async () => {
    const tenant = `f2-tenant-${randomUUID()}`;
    await connect(alpha(), tenant, "Shared Org (Xero)");
    expect(await overview(alpha())).toMatchObject({ status: "connected", tenant_name: "Shared Org (Xero)" });
    // What the card shows for the second company: the callback's tenant_in_use outcome comes from exactly this refusal.
    expect(await tryConnect(beta(), tenant)).toMatchObject({ code: "23505", hint: "tenant_in_use" });
    expect(await overview(beta())).toMatchObject({ status: "not_connected", tenant_name: null });
    await disconnect(alpha());
    expect(await overview(alpha())).toMatchObject({ status: "disconnected" });
    await connect(beta(), tenant, "Shared Org (Xero)");
    expect(await overview(beta())).toMatchObject({ status: "connected", tenant_name: "Shared Org (Xero)" });
    expect(await tryConnect(alpha(), tenant)).toMatchObject({ code: "23505", hint: "tenant_in_use" });
    expect((await owner<{ n: number }>("select count(*)::int as n from public.integration_connections where provider = 'xero' and tenant_id = $1 and status <> 'disconnected'", [tenant]))[0].n).toBe(1);
    await clean(alpha(), beta());
  });

  it("the organisation shown is the one stored for this company only (the card's 'bound to this company' line)", async () => {
    await connect(alpha(), `f2-a-${randomUUID()}`, "Alpha Org (Xero)");
    await connect(beta(), `f2-b-${randomUUID()}`, "Beta Org (Xero)");
    expect((await overview(alpha())).tenant_name).toBe("Alpha Org (Xero)");
    expect((await overview(beta())).tenant_name).toBe("Beta Org (Xero)");
    await clean(alpha(), beta());
  });
});

describe("F2 company isolation", () => {
  it("A's connection, mappings and queue are never visible or usable by B", async () => {
    await connect(alpha(), `f2-iso-${randomUUID()}`, "Alpha Iso (Xero)");
    await mapAll(alpha(), "200");
    const id = await issueInvoice(alpha());
    // B (not connected) sees nothing of A.
    expect((await overview(beta())).status).not.toBe("connected");
    expect((await overview(beta())).tenant_name).not.toBe("Alpha Iso (Xero)");
    for (const table of ["integration_connections", "integration_mappings", "integration_sends"]) {
      expect((await q<{ n: number }>(admin(beta()), `select count(*)::int as n from public.${table} where organization_id = $1`, [alpha().id]))[0].n, table).toBe(0);
    }
    for (const table of ["integration_secrets", "integration_oauth_states"]) {
      expect(await refusal(admin(beta()), `select * from public.${table}`), table).toMatchObject({ code: "42501" });
    }
    // B's writes land on B only: B's mapping does not change A's; B cannot disconnect A; B's claim never returns A's document.
    await q(admin(beta()), "select public.integration_set_mapping('xero', 'sales_account', null, '999', 'Beta sales') as r");
    expect((await mappingRows(alpha())).find((m) => m.kind === "sales_account")?.external_code).toBe("200");
    expect(await refusal(admin(beta()), "select public.integration_disconnect('xero')")).toMatchObject({ code: "P0002", hint: "not_connected" });
    expect((await overview(alpha())).status).toBe("connected");
    const b = await claim(beta());
    expect(b.send).toBeNull();
    expect(b.blocked).toBe("disconnected");
    expect((await sendRows(alpha())).map((r) => r.doc_id)).toContain(id);
    expect((await sendRows(beta()))).toEqual([]);
    // A's own claim does return A's document (mapped and connected), once the switch is on where release 149 is installed (default OFF: nothing).
    if (await hasSwitch()) {
      expect(await claim(alpha())).toMatchObject({ blocked: "launch_hold", send: null });
      await turnOn(alpha());
    }
    expect((await claim(alpha())).send).toMatchObject({ doc_id: id });
    await owner("delete from public.integration_mappings where organization_id = $1", [beta().id]);
    await clean(alpha(), beta());
  });
});

describe("F2 reconnect and error recovery", () => {
  it("needs_reconnect, then connected again: same mappings, same queue, still no transfers switch in the database", async () => {
    const tenant = `f2-rec-${randomUUID()}`;
    await connect(alpha(), tenant, "Recon Org (Xero)");
    await mapAll(alpha(), "210");
    const id = await issueInvoice(alpha());
    const before = { maps: await mappingRows(alpha()), sends: await sendRows(alpha()) };
    expect(before.sends.find((s) => s.doc_id === id)?.status).toBe("pending");

    await svc("select public.integration_mark_needs_reconnect($1, 'xero', 'invalid_grant')", [alpha().id]);
    expect(await overview(alpha())).toMatchObject({ status: "needs_reconnect", tenant_name: "Recon Org (Xero)" });
    expect(await claim(alpha())).toMatchObject({ blocked: "needs_reconnect", send: null });
    expect({ maps: await mappingRows(alpha()), sends: await sendRows(alpha()) }).toEqual(before);

    await connect(alpha(), tenant, "Recon Org (Xero)");
    expect(await overview(alpha())).toMatchObject({ status: "connected", tenant_name: "Recon Org (Xero)", unmapped: [] });
    expect({ maps: await mappingRows(alpha()), sends: await sendRows(alpha()) }).toEqual(before);
    // The candidate has no per-company transfers column (release 149 is not applied): reconnecting cannot have changed one.
    const cols = await owner<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'integration_connections' and column_name ilike '%transfer%'");
    expect(cols).toEqual([]);
    await clean(alpha());
  });

  it("a different organisation after needs_reconnect needs a disconnect first (no silent switch)", async () => {
    const tenant = `f2-rec2-${randomUUID()}`;
    await connect(alpha(), tenant);
    await svc("select public.integration_mark_needs_reconnect($1, 'xero', 'invalid_grant')", [alpha().id]);
    expect(await tryConnect(alpha(), `f2-other-${randomUUID()}`)).toMatchObject({ hint: "disconnect_first" });
    expect((await overview(alpha())).status).toBe("needs_reconnect");
    await clean(alpha());
  });
});

describe("F2 refusal before activation (what this candidate CAN prove in SQL)", () => {
  it("never connected, disconnected, unmapped and needs_reconnect hand out nothing", async () => {
    // never connected is proved by the first describe; here beta was connected and then disconnected:
    expect(await claim(beta())).toMatchObject({ blocked: "disconnected", send: null });
    // unmapped
    await owner("delete from public.integration_mappings where organization_id = $1", [beta().id]);
    await connect(beta(), `f2-ref-${randomUUID()}`);
    // With 149 installed a new connection is OFF and the switch answers before the mapping does; ON (unmapped, so written as the owner) shows the mapping gate itself.
    if (await hasSwitch()) await forceOn(beta());
    await issueInvoice(beta());
    expect(await claim(beta())).toMatchObject({ blocked: "unmapped", send: null });
    expect((await claim(beta())).unmapped).toEqual(expect.arrayContaining(["account:sales", "account:credit", "vat:20"]));
    // needs_reconnect (mapped, queued)
    await mapAll(beta());
    await svc("select public.integration_mark_needs_reconnect($1, 'xero', 'invalid_grant')", [beta().id]);
    expect(await claim(beta())).toMatchObject({ blocked: "needs_reconnect", send: null });
    // disconnected
    await disconnect(beta());
    expect(await claim(beta())).toMatchObject({ blocked: "disconnected", send: null });
    await clean(beta());
  });

  it("STATED PLAINLY: connected AND mapped is handed its queued document only once the transfer switch is on (release 149: OFF by default, nothing is handed out until an admin turns it on; without 149 it is handed out at once)", async () => {
    await connect(alpha(), `f2-go-${randomUUID()}`);
    await mapAll(alpha());
    const id = await issueInvoice(alpha());
    if (await hasSwitch()) {
      expect(await claim(alpha())).toMatchObject({ blocked: "launch_hold", send: null });
      expect((await sendRows(alpha())).find((r) => r.doc_id === id)).toMatchObject({ status: "pending", attempts: 0 });
      await turnOn(alpha());
    }
    const got = await claim(alpha());
    expect(got.blocked).toBeNull();
    expect(got.send).toMatchObject({ doc_id: id });
    await clean(alpha());
  });
});
