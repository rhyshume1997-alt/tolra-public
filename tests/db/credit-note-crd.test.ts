/**
 * Credit note numbers after migration 078 (G9, Rhys's decision): new credit notes are CRD-####, ascending in the order issued, carrying on
 * after the highest credit note number the company has (CRD-n, or CN-n from before 078); taken numbers are skipped; concurrent issues
 * never share a number; credit notes recorded outside Tolra are set by the owner with seed_credit_note_number (never moves back);
 * existing credit_ref values never change; who may take numbers is unchanged (admin and office).
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

import { type Who, as, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;

const sql = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows);

/** An issued invoice (2 x £50 + 20% VAT) of `who`'s company. */
async function issuedInvoice(who: Who): Promise<string> {
  return as(who, async (db) => {
    const id = (await db.query<{ id: string }>(
      `select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as id`,
      [JSON.stringify({ customer: "Credit Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" }),
       JSON.stringify([{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }])])).rows[0].id;
    await db.query("select public.issue_invoice($1)", [id]);
    return id;
  });
}
/** A draft credit note for one bush of the invoice. */
async function draft(who: Who, invoice: string): Promise<string> {
  const line = (await sql<{ id: string }>("select id from public.invoice_line_items where invoice_id = $1 order by position limit 1", [invoice]))[0].id;
  return as(who, async (db) => (await db.query<{ id: string }>("select public.create_credit_note($1, 'Returned', current_date, $2::jsonb) as id",
    [invoice, JSON.stringify([{ invoice_line_id: line, quantity: 1 }])])).rows[0].id);
}
const issue = (who: Who, credit: string) => as(who, async (db: Client) => (await db.query<{ ref: string }>("select public.issue_credit_note($1) as ref", [credit])).rows[0].ref);
/** A credit note as SliQ's would arrive, written by the owner (not through the API): issued, numbered. */
async function existing(org: string, invoice: string, ref: string) {
  await sql(`insert into public.credit_notes (organization_id, invoice_id, credit_ref, status, customer, subtotal, vat, total, issued_at)
             values ($1, $2, $3, 'issued', 'Credit Co', 1, 0.2, 1.2, now())`, [org, invoice, ref]);
}
const refs = async (org: string) => (await sql<{ r: string }>("select credit_ref as r from public.credit_notes where organization_id = $1 and credit_ref is not null order by credit_ref", [org])).map((x) => x.r);

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

describe("CRD numbers", () => {
  it("a company with no credit notes starts at CRD-0001; office may issue; workshop and viewer can't take numbers", async () => {
    const inv = await issuedInvoice(B().admin);
    expect(await issue(B().office, await draft(B().admin, inv))).toBe("CRD-0001");
    for (const who of [B().workshop, B().viewer]) expect(await refusal(who, "select public.next_doc_number('CRD')"), "role").toMatchObject({ code: "42501" });
    expect(await refusal(B().admin, "select public.next_doc_number('CRX')")).toMatchObject({ code: "22023" });
  });

  it("after CRD-0166 and CRD-2166 the next is CRD-2167, then CRD-2168; the two stay as they are", async () => {
    const org = world.tenants.alpha.id;
    const inv = await issuedInvoice(A().admin);
    await existing(org, inv, "CRD-0166");
    await existing(org, inv, "CRD-2166");
    expect(await issue(A().admin, await draft(A().admin, inv))).toBe("CRD-2167");
    expect(await issue(A().office, await draft(A().admin, inv))).toBe("CRD-2168");
    expect(await refs(org)).toEqual(["CRD-0166", "CRD-2166", "CRD-2167", "CRD-2168"]);
  });

  it("a taken number is skipped, never issued twice", async () => {
    const org = world.tenants.alpha.id;
    const inv = await issuedInvoice(A().admin);
    await existing(org, inv, "CRD-2169"); // loaded after the counter reached 2168
    expect(await issue(A().admin, await draft(A().admin, inv))).toBe("CRD-2170");
    // The next number taken behind the counter's back: still never issued twice.
    await existing(org, inv, "CRD-2171");
    expect(await issue(A().admin, await draft(A().admin, inv))).toBe("CRD-2172");
    const all = await refs(org);
    expect(new Set(all).size).toBe(all.length);
  });

  it("concurrent issues get distinct, consecutive numbers", async () => {
    const org = world.tenants.alpha.id;
    const before = (await sql<{ last: number }>("select last from public.doc_counters where organization_id = $1 and prefix = 'CRD'", [org]))[0].last;
    const notes: string[] = [];
    for (let i = 0; i < 10; i++) notes.push(await draft(A().admin, await issuedInvoice(A().admin)));
    const got = await Promise.all(notes.map((n, i) => issue(i % 2 ? A().office : A().admin, n)));
    expect(new Set(got).size).toBe(10);
    const nums = got.map((r) => Number(r.slice(4))).sort((x, y) => x - y);
    expect(nums).toEqual(Array.from({ length: 10 }, (_, i) => before + 1 + i));
    const all = await refs(org);
    expect(new Set(all).size).toBe(all.length);
  });

  it("a company that issued CN numbers before 078 carries on above them in CRD; CN refs are not changed", async () => {
    const org = world.tenants.beta.id;
    const inv = await issuedInvoice(B().admin);
    await existing(org, inv, "CN-0012");
    expect(await issue(B().admin, await draft(B().admin, inv))).toBe("CRD-0013");
    expect(await refs(org)).toEqual(["CN-0012", "CRD-0001", "CRD-0013"]);
  });

  it("the owner sets SliQ's highest number for credit notes recorded outside Tolra; it never moves back; no API role may", async () => {
    const org = world.tenants.beta.id;
    expect((await sql<{ r: string }>("select public.seed_credit_note_number($1, 'CRD-2166') as r", [org]))[0].r).toBe("CRD-2167");
    expect((await sql<{ r: string }>("select public.seed_credit_note_number($1, 'CRD-0166') as r", [org]))[0].r).toBe("CRD-2167");
    const inv = await issuedInvoice(B().admin);
    expect(await issue(B().admin, await draft(B().admin, inv))).toBe("CRD-2167");
    await expect(sql("select public.seed_credit_note_number($1, 'CN-9')", [org])).rejects.toMatchObject({ code: "22023" });
    expect(await refusal(B().admin, "select public.seed_credit_note_number($1, 'CRD-9999')", [org])).toMatchObject({ code: "42501" });
    // Alpha's counter is untouched by beta's seed.
    expect((await sql<{ last: number }>("select last from public.doc_counters where organization_id = $1 and prefix = 'CRD'", [world.tenants.alpha.id]))[0].last).toBeGreaterThan(2170);
  });

  it("other series are numbered exactly as before (no floor)", async () => {
    const next = await as(A().admin, async (db) => (await db.query<{ r: string }>("select public.next_doc_number('SO') as r")).rows[0].r);
    expect(next).toMatch(/^SO-\d{4}$/);
    const after = await as(A().admin, async (db) => (await db.query<{ r: string }>("select public.next_doc_number('SO') as r")).rows[0].r);
    expect(Number(after.slice(3))).toBe(Number(next.slice(3)) + 1);
  });
});
