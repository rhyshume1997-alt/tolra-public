/**
 * X149 test harness (adapted from the W-X proof) (not a test file): company states, queued invoices, and the four real send paths (daily sweep body, after-issue route,
 * manual send route, batch route) driven in-process against a disposable PostgreSQL, with the stubbed Xero transport (x149-support.ts).
 * The route modules must be imported by the test AFTER its vi.mock calls (server-only, @/lib/server/auth, @/lib/server/supabase-admin).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { encryptSecret } from "@/lib/integrations/crypto";

import { createSoloTenant, withDb } from "../support/fixtures";
import { q } from "./time-support";
import { type Who, createXeroStub, inRole } from "./x149-support";

export const KEY = createHash("sha256").update("x149-key-disposable").digest();
export const ENV_ON = { XERO_CLIENT_ID: "x149-client-id", XERO_CLIENT_SECRET: "x149-client-secret", NEXT_PUBLIC_SITE_URL: "http://localhost:3000", INTEGRATIONS_ENCRYPTION_KEY: KEY.toString("base64") };
export const credentials = (on: boolean, stubEnv: (k: string, v: string | undefined) => void) => {
  for (const [k, v] of Object.entries(ENV_ON)) stubEnv(k, on ? v : undefined);
};

export type Co = { label: string; id: string; admin: { id: string }; tenant: string };
export type Xero = ReturnType<typeof createXeroStub>;

const cipher = (org: string, purpose: "refresh" | "access") => encryptSecret(`x149-${purpose}-${randomUUID()}`, { organizationId: org, provider: "xero", purpose }, KEY);
const hash = () => randomBytes(32).toString("hex");
const svc = <R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => inRole(process.env.TEST_DATABASE_URL!, { kind: "service" }, async (db) => (await db.query<R>(sql, params)).rows);
export const owner = <R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => withDb(async (db) => (await db.query<R>(sql, params)).rows);

export async function newCompany(runId: string, label: string): Promise<Co> {
  const t = await createSoloTenant(runId, label);
  return { label, id: t.id, admin: { id: t.admin.id }, tenant: `tenant-${label}-${runId}` };
}

/** Connects as the callback does (begin as the admin, consume + store as the server), real ciphertext, access token valid 30 minutes. */
export async function connect(co: Co, tenant = co.tenant) {
  const state = hash();
  await q(co.admin, "select public.integration_oauth_begin('xero', $1, $2) as id", [state, encryptSecret("pkce", { organizationId: co.id, provider: "xero", purpose: "pkce" }, KEY)]);
  await svc("select public.integration_oauth_consume($1, $2, 'xero', $3) as r", [co.id, co.admin.id, state]);
  await svc("select public.integration_store_connection($1, $2, 'xero', $3, $4, $5, $6, $7, now() + interval '30 minutes', 1) as r",
    [co.id, co.admin.id, tenant, `${co.label} Xero`, randomUUID(), cipher(co.id, "refresh"), cipher(co.id, "access")]);
}
export const disconnect = (co: Co) => q(co.admin, "select public.integration_disconnect('xero') as r");
export const needsReconnect = (co: Co) => svc("select public.integration_mark_needs_reconnect($1, 'xero', 'x149: refused') as r", [co.id]);
export async function mapAll(co: Co) {
  await q(co.admin, "select public.integration_set_mapping('xero', 'sales_account', null, '200', 'Sales') as r");
  await q(co.admin, "select public.integration_set_mapping('xero', 'credit_account', null, '200', 'Sales') as r");
  await q(co.admin, "select public.integration_set_mapping('xero', 'tax_rate', '20', 'OUTPUT2', 'VAT 20') as r");
}
export const setOld = (co: Co) => owner("update public.integration_connections set connected_at = now() - interval '40 days' where organization_id = $1", [co.id]);

type Line = { description?: string; quantity?: number; unit_price: number; vat_pct?: number; vat_exempt?: boolean };
let seq = 0;
/** A draft invoice written as the owner, then issued (status draft -> issued): the database's own trigger queues the send if it will. */
export async function issuedInvoice(co: Co, runId: string, lines: Line[] = [{ unit_price: 100 }], customer = "Acme Engineering Ltd"): Promise<{ id: string; ref: string }> {
  seq += 1;
  const ref = `INV-X149-${runId}-${seq}`;
  const net = Math.round(lines.reduce((s, l) => s + (l.quantity ?? 1) * l.unit_price, 0) * 100) / 100;
  const vatAmt = Math.round(lines.reduce((s, l) => s + (l.vat_exempt ? 0 : Math.round((l.quantity ?? 1) * l.unit_price * (l.vat_pct ?? 20)) / 100), 0) * 100) / 100;
  const id = await withDb(async (db) => {
    const id = (await db.query<{ id: string }>(
      `insert into public.invoices (organization_id, customer, status, subtotal, vat, total, vat_enabled, carriage, carriage_vat, due_date, invoice_date)
       values ($1, $5, 'draft', $2, $3, $4, true, 0, false, '2026-11-30', '2026-10-21') returning id`, [co.id, net, vatAmt, Math.round((net + vatAmt) * 100) / 100, customer])).rows[0].id;
    for (const [i, l] of lines.entries()) {
      await db.query(`insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
                      values ($1, $2, $3, $4, $5, $6, $7, $8)`, [co.id, id, i, l.description ?? `Part ${i}`, l.quantity ?? 1, l.unit_price, l.vat_pct ?? 20, l.vat_exempt ?? false]);
    }
    await db.query("update public.invoices set status = 'issued', invoice_ref = $2, issued_at = now() where id = $1", [id, ref]);
    return id;
  });
  return { id, ref };
}

export const sendRows = (co: Co) => owner<{ doc_ref: string; action: string; status: string; attempts: number; external_id: string | null; last_error: string | null }>(
  "select doc_ref, action, status, attempts, external_id, last_error from public.integration_sends where organization_id = $1 and provider = 'xero' order by created_at, id", [co.id]);

/** InvoiceNumbers PUT to Xero, by the tenant header they carried. */
export function putsByTenant(x: Xero): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of x.calls) {
    if (c.host === "api.xero.com" && c.method === "PUT" && c.path.startsWith("/api.xro/2.0/Invoices")) {
      const number = String((c.body as { Invoices: Array<{ InvoiceNumber: string }> }).Invoices[0].InvoiceNumber);
      (out[c.tenant ?? "?"] ??= []).push(number);
    }
  }
  return out;
}

export const who = (co: Co): Who => ({ kind: "user", id: co.admin.id });

export const post = (body: unknown) => new Request("https://app.example.test/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

export type Routes = {
  afterIssue: (req: Request) => Promise<Response>;
  send: (req: Request) => Promise<Response>;
  batch: (req: Request) => Promise<Response>;
  sweep: () => Promise<unknown>;
};
