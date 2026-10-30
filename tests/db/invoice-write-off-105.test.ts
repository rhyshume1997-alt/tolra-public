/**
 * Migration 105 (S5 review finding S5-A1): an issued invoice is written off, and a write-off reversed, only with write_off_invoice /
 * reverse_write_off. Proved in SQL as PostgREST runs it (role authenticated with the JWT claims; the owner for the exemption), so it also
 * runs against plain PostgreSQL with stand-ins (tests/scripts/invoice-write-off-105.sql is the same proof for psql):
 *   - THE GAP: office or admin PATCHes an issued or sent invoice to written_off, or a written-off one back: refused (42501, hint
 *     invoice_write_off_direct), the row unchanged; drafts keep 027's / 091's refusals; other status moves stay open;
 *   - write_off_invoice: admin (aal2 when the company requires it) and office only; reason 10 to 500 characters; refuses a draft, void,
 *     already written off, imported payments to confirm, nothing left to pay; another company's invoice is "not found"; issued, sent and
 *     part paid are written off with amounts untouched and a WRITE_OFF_INVOICE audit row carrying the reason;
 *   - reverse_write_off: only from written off; back to issued / sent / partial by the figures; REVERSE_WRITE_OFF audit row;
 *   - the app's write_audit can't make up either event; the database owner is exempt.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
type Role = "admin" | "office" | "workshop";
type Tenant = "alpha" | "beta";
let seq = 0;

/** Statements as a signed-in member (authenticated), in one transaction, committed. `requireMfa` sets the company's admin MFA rule for this transaction only. */
async function inSession<T>(role: Role, fn: (db: Client) => Promise<T>, opts: { tenant?: Tenant; aal?: "aal1" | "aal2"; requireMfa?: boolean } = {}): Promise<T> {
  const tenant = world.tenants[opts.tenant ?? "alpha"];
  return withDb(async (db) => {
    await db.query("begin");
    try {
      if (opts.requireMfa) await db.query("update public.organizations set require_admin_mfa = true where id = $1", [tenant.id]);
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: tenant.users[role].id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: opts.aal ?? "aal2" })]);
      const result = await fn(db);
      await db.query(opts.requireMfa ? "rollback" : "commit");
      return result;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}
async function outcome(role: Role, text: string, params: unknown[] = [], opts: Parameters<typeof inSession>[2] = {}) {
  try {
    await inSession(role, (db) => db.query(text, params), opts);
    return "ok";
  } catch (err) {
    const e = err as { code?: string; hint?: string };
    return `${e.code}${e.hint ? ` ${e.hint}` : ""}`;
  }
}
const owner = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows);

/** An invoice as the owner writes it (the guards don't hold the owner): £120, in the given state. */
async function invoice(state: { status: string; ref?: string | null; sent?: boolean; paid?: number; credited?: number; unverified?: boolean }, tenant: Tenant = "alpha") {
  const org = world.tenants[tenant].id;
  const ref = state.ref === undefined ? `WO105-${world.runId}-${(seq += 1)}` : state.ref;
  const [row] = await owner<{ id: string }>(`insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, sent_date, amount_paid, credited_amount, refunded_amount, payment_unverified)
    values ($1, $2, 'Write Off Co', 100, 20, 120, $3, $4, $5, $6, 0, $7) returning id`,
    [org, ref, state.status, state.sent ? new Date().toISOString() : null, state.paid ?? 0, state.credited ?? 0, state.unverified ?? false]);
  if (state.paid) await owner("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, source) values ($1, $2, $3, current_date, 'BACS', 'recorded')", [org, row.id, state.paid]);
  return row.id;
}
const statusOf = async (id: string) => (await owner<{ status: string }>("select status from public.invoices where id = $1", [id]))[0].status;
const audits = (action: string, id: string) =>
  owner<{ actor_user_id: string; metadata: Record<string, unknown> }>("select actor_user_id, metadata from security_audit.audit_log where action = $1 and entity_table = 'invoices' and entity_id = $2", [action, id]);
const writeOff = (role: Role, id: string, reason: string | null = "Customer has gone into liquidation", opts: Parameters<typeof inSession>[2] = {}) =>
  outcome(role, "select public.write_off_invoice($1, $2)", [id, reason], opts);
const reverse = (role: Role, id: string, reason: string | null = "Customer paid after all", opts: Parameters<typeof inSession>[2] = {}) =>
  outcome(role, "select public.reverse_write_off($1, $2)", [id, reason], opts);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("105: a direct status change to or from written off is refused", () => {
  for (const role of ["admin", "office"] as const) {
    it(`THE GAP: ${role} PATCHes an issued or sent invoice to written_off: refused, the row unchanged`, async () => {
      for (const state of [{ status: "issued" }, { status: "sent", sent: true }]) {
        const id = await invoice(state);
        expect(await outcome(role, "update public.invoices set status = 'written_off' where id = $1", [id])).toBe("42501 invoice_write_off_direct");
        expect(await statusOf(id)).toBe(state.status);
      }
    });

    it(`${role} can't PATCH a written-off invoice back to issued or sent`, async () => {
      const id = await invoice({ status: "written_off" });
      for (const to of ["issued", "sent"]) expect(await outcome(role, "update public.invoices set status = $2 where id = $1", [id, to])).toBe("42501 invoice_write_off_direct");
      expect(await statusOf(id)).toBe("written_off");
    });
  }

  it("part paid and drafts keep the refusals that came first (076, 027, 091); other status moves stay open; the owner is exempt", async () => {
    const part = await invoice({ status: "partial", paid: 20, sent: true });
    expect(await outcome("office", "update public.invoices set status = 'written_off' where id = $1", [part])).toBe("42501");
    const draft = await invoice({ status: "draft", ref: null });
    expect(await outcome("office", "update public.invoices set status = 'written_off' where id = $1", [draft])).toBe("23514");
    expect(await outcome("office", "update public.invoices set status = 'written_off', invoice_ref = $2 where id = $1", [draft, `WO105-OWN-${world.runId}`])).toBe("42501 invoice_issue_direct");
    const open = await invoice({ status: "issued" });
    expect(await outcome("office", "update public.invoices set status = 'sent' where id = $1", [open])).toBe("ok");
    await owner("update public.invoices set status = 'written_off' where id = $1", [open]);
    expect(await statusOf(open)).toBe("written_off");
  });

  it("the app's write_audit can't make up either event", async () => {
    const id = await invoice({ status: "issued" });
    for (const action of ["WRITE_OFF_INVOICE", "REVERSE_WRITE_OFF"]) {
      expect(await outcome("office", "select public.write_audit($1, 'invoices', $2, null, null, '{}'::jsonb, null, null)", [action, id])).toBe("42501");
    }
  });
});

describe("105: write_off_invoice", () => {
  it("refuses a short or missing reason, a draft, void, already written off, payments to confirm and nothing left to pay", async () => {
    const issued = await invoice({ status: "issued" });
    for (const reason of [null, "", "too short", "         x         ", "x".repeat(501)]) expect(await writeOff("office", issued, reason)).toBe("22023 write_off_reason_required");
    expect(await writeOff("office", await invoice({ status: "draft", ref: null }))).toBe("22023 invoice_draft");
    expect(await writeOff("office", await invoice({ status: "void" }))).toBe("22023 invoice_void");
    expect(await writeOff("office", await invoice({ status: "written_off" }))).toBe("22023 invoice_already_written_off");
    expect(await writeOff("office", await invoice({ status: "sent", sent: true, unverified: true }))).toBe("22023 invoice_payments_unconfirmed");
    expect(await writeOff("office", await invoice({ status: "paid", paid: 120 }))).toBe("22023 invoice_nothing_owed");
    expect(await writeOff("office", await invoice({ status: "issued", credited: 120 }))).toBe("22023 invoice_nothing_owed");
    expect(await statusOf(issued)).toBe("issued");
  });

  it("workshop is not authorised; another company's invoice is not found; an admin needs aal2 when the company requires it", async () => {
    const id = await invoice({ status: "issued" });
    expect(await writeOff("workshop", id)).toBe("42501");
    expect(await writeOff("office", id, undefined, { tenant: "beta" })).toBe("P0002");
    expect(await writeOff("admin", id, undefined, { aal: "aal1", requireMfa: true })).toBe("42501 mfa_required");
    expect(await statusOf(id)).toBe("issued");
    expect(await audits("WRITE_OFF_INVOICE", id)).toHaveLength(0);
  });

  it("office writes off issued, sent and part paid: amounts untouched, one audit row each with the trimmed reason and the balance", async () => {
    const issued = await invoice({ status: "issued" });
    const sent = await invoice({ status: "sent", sent: true });
    const part = await invoice({ status: "partial", paid: 20, sent: true });
    expect(await writeOff("office", issued, "  Customer has gone into liquidation  ")).toBe("ok");
    expect(await writeOff("office", sent)).toBe("ok");
    expect(await writeOff("office", part)).toBe("ok");
    for (const id of [issued, sent, part]) expect(await statusOf(id)).toBe("written_off");
    const money = await owner<{ total: string; subtotal: string; vat: string; amount_paid: string }>("select total, subtotal, vat, amount_paid from public.invoices where id = $1", [part]);
    expect(money[0]).toMatchObject({ total: "120.00", subtotal: "100.00", vat: "20.00", amount_paid: "20.00" });
    const [row] = await audits("WRITE_OFF_INVOICE", issued);
    expect(row.actor_user_id).toBe(world.tenants.alpha.users.office.id);
    expect(row.metadata).toMatchObject({ reason: "Customer has gone into liquidation", from_status: "issued", balance_written_off: 120 });
    expect((await audits("WRITE_OFF_INVOICE", part))[0].metadata).toMatchObject({ from_status: "partial", balance_written_off: 100 });
    expect(await writeOff("office", issued)).toBe("22023 invoice_already_written_off");
  });

  it("an admin on aal2 writes off and reverses", async () => {
    const id = await invoice({ status: "issued" });
    expect(await writeOff("admin", id, undefined, { aal: "aal2" })).toBe("ok");
    expect(await reverse("admin", id, undefined, { aal: "aal2" })).toBe("ok");
    expect(await statusOf(id)).toBe("issued");
  });
});

describe("105: reverse_write_off", () => {
  it("refuses an invoice that isn't written off and a short reason; another company's is not found", async () => {
    const issued = await invoice({ status: "issued" });
    expect(await reverse("office", issued)).toBe("22023 invoice_not_written_off");
    const off = await invoice({ status: "written_off" });
    expect(await reverse("office", off, "short")).toBe("22023 write_off_reason_required");
    expect(await reverse("office", off, undefined, { tenant: "beta" })).toBe("P0002");
    expect(await reverse("workshop", off)).toBe("42501");
    expect(await statusOf(off)).toBe("written_off");
  });

  it("puts the status back by the figures (issued, sent, partial) with a REVERSE_WRITE_OFF row; a PATCH back is refused again", async () => {
    const issued = await invoice({ status: "issued" });
    const sent = await invoice({ status: "sent", sent: true });
    const part = await invoice({ status: "partial", paid: 20, sent: true });
    for (const id of [issued, sent, part]) {
      expect(await writeOff("office", id)).toBe("ok");
      expect(await reverse("office", id)).toBe("ok");
    }
    expect([await statusOf(issued), await statusOf(sent), await statusOf(part)]).toEqual(["issued", "sent", "partial"]);
    expect((await audits("REVERSE_WRITE_OFF", part))[0].metadata).toMatchObject({ reason: "Customer paid after all", to_status: "partial", balance_due: 100 });
    expect(await outcome("office", "update public.invoices set status = 'written_off' where id = $1", [issued])).toBe("42501 invoice_write_off_direct");
  });
});
