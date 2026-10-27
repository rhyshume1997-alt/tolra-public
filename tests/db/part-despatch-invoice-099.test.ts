/**
 * Migration 099: a draft invoice bills what was despatched, and the same despatched quantity is never on two invoices.
 *
 *   - a full despatch drafts the full quantities, linked to their order lines, to the penny;
 *   - a part despatch drafts only that part; a second part goes on the job's draft (or its own draft), the rest stays outstanding;
 *   - a draft's quantity can't be raised above what is despatched and not on another invoice: through the editor, a direct write,
 *     or two writers at once; the editor's links are kept;
 *   - reducing or deleting a line of an unissued draft frees that quantity: the next draft of the order takes it, or the editor adds it
 *     back; a reduction racing a raise is serialised;
 *   - a line is 'order' (linked, made only by the drafting functions) or 'manual' (tooling, carriage: never linked);
 *   - the delivery note path and Job Finish never bill the same quantity twice, also against a Job Finish draft made before 099;
 *   - an issued invoice is never changed; another company can't read or touch any of it.
 *
 * SQL as PostgREST runs it (role authenticated with the JWT claims), synthetic rows only.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, allowInspectors, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, become, q, refusal } from "./time-support";

let world: SyntheticWorld;
let seq = 0;
const alpha = () => world.tenants.alpha;
const who = (role: "admin" | "office" | "workshop" | "viewer"): Who => ({ id: alpha().users[role].id });
const betaAdmin = (): Who => ({ id: world.tenants.beta.users.admin.id });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = async <R>(sql: string, params: unknown[] = []) => withDb(async (db) => (await db.query(sql, params)).rows as R[]);
const one = async <R>(sql: string, params: unknown[] = []) => (await rows<R>(sql, params))[0];

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  await allowInspectors(world);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

// Two lines with pennies that matter: 12 x 150.00 at 20% and 7 x 14.29 at 20% (7 x 14.29 = 100.03, VAT 20.01).
const LINES = [
  { description: "Flange 80mm", quantity: 12, unit_price: 150 },
  { description: "Bush 25mm", quantity: 7, unit_price: 14.29 },
];

/** A confirmed order with LINES (made by the database owner), optionally converted to its job by the office. */
async function order(org = alpha().id) {
  seq += 1;
  const so = await one<{ id: string }>(
    "insert into public.sales_orders (organization_id, so_number, customer, status, total_value, vat_enabled, vat_pct, vat_exempt) values ($1, $2, 'Part Co', 'confirmed', 1900.03, true, 20, false) returning id",
    [org, `SO-PD-${world.runId}-${seq}`]);
  const ids: string[] = [];
  for (const [position, l] of LINES.entries()) {
    ids.push((await one<{ id: string }>(
      "insert into public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, $3, $4, $5, $6, 20, false) returning id",
      [org, so.id, position, l.description, l.quantity, l.unit_price])).id);
  }
  return { orderId: so.id, flange: ids[0], bush: ids[1] };
}
async function orderJob() {
  const o = await order();
  const made = (await q<{ r: { job_id: string } }>(who("office"), "select public.convert_sales_order($1) as r", [o.orderId]))[0].r;
  return { ...o, jobId: made.job_id };
}

const finish = (jobId: string) => q(who("workshop"), "select public.finish_job($1, $2, now())", [jobId, randomUUID()]);
const INSPECT_SQL = `select public.inspect_job(p_job => $1, p_result => 'pass', p_criteria => 'Drawing rev C', p_measured => 'All in tolerance',
  p_expected_version => (select worksheet_version from public.jobs where id = $1), p_override_reason => null, p_disposition => null, p_failure => null,
  p_client_op_id => null, p_concession_reason => null)`;
async function complete(jobId: string) {
  await finish(jobId);
  await q(who("office"), INSPECT_SQL, [jobId]);
}

const DN_SQL = "select public.create_delivery_note($1, $2, current_date, current_date, null, null, $3::jsonb) as r";
/** A delivery note made by the workshop (the job must be released) and sent out by the office: 059 drafts it. */
async function despatch(o: { orderId: string; jobId?: string }, picks: Array<[string, number]>) {
  const dn = (await q<{ r: { id: string } }>(who("workshop"), DN_SQL, [o.orderId, o.jobId ?? null, JSON.stringify(picks.map(([line_id, quantity]) => ({ line_id, quantity })))]))[0].r;
  await q(who("office"), "update public.delivery_notes set status = 'despatched' where id = $1", [dn.id]);
  return dn.id;
}
/** A note already sent out, written by the database owner (as a maintenance change or import would: no automatic draft). */
async function despatchedByOwner(o: { orderId: string; jobId?: string }, picks: Array<[string, number]>) {
  seq += 1;
  const dn = await one<{ id: string }>(
    "insert into public.delivery_notes (organization_id, dn_number, customer, sales_order_id, job_id, status) values ($1, $2, 'Part Co', $3, $4, 'despatched') returning id",
    [alpha().id, `DLN-PD-${world.runId}-${seq}`, o.orderId, o.jobId ?? null]);
  for (const [position, [line, quantity]] of picks.entries()) {
    const l = await one<{ description: string }>("select description from public.sales_order_lines where id = $1", [line]);
    await rows("insert into public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, sales_order_line_id) values ($1, $2, $3, $4, $5, $6)",
      [alpha().id, dn.id, position, l.description, quantity, line]);
  }
  return dn.id;
}

const noteInvoice = async (note: string) => (await one<{ invoice_id: string | null }>("select invoice_id from public.delivery_notes where id = $1", [note])).invoice_id;
const invoice = (id: string) => one<{ status: string; invoice_ref: string | null; subtotal: string; vat: string; total: string; updated_at: Date }>(
  "select status, invoice_ref, subtotal, vat, total, updated_at from public.invoices where id = $1", [id]);
const lines = (id: string) => rows<{ id: string; description: string; quantity: string; unit_price: string; sales_order_line_id: string | null }>(
  "select id, description, quantity, unit_price, sales_order_line_id from public.invoice_line_items where invoice_id = $1 order by position, id", [id]);
const short = async (id: string) => (await lines(id)).map((l) => [l.description, Number(l.quantity)]);
/** The dashboard's "Complete jobs not yet fully despatched or invoiced" row for a job, as the office reads it. */
const awaiting = async (jobId: string) => (await q<{ job_id: string; to_despatch: string | null; to_invoice: string }>(who("office"), "select * from public.jobs_awaiting_despatch_or_invoice()"))
  .filter((r) => r.job_id === jobId).map((r) => ({ toDespatch: r.to_despatch === null ? null : Number(r.to_despatch), toInvoice: Number(r.to_invoice) }));
const jobInvoices = (jobId: string) => rows<{ id: string; status: string }>("select id, status from public.invoices where job_id = $1 order by created_at, id", [jobId]);
const balances = (by: Who, id: string) => q<{ line_position: number; sales_order_line_id: string | null; ordered: string | null; despatched: string | null; on_other_invoices: string | null; available: string | null }>(
  by, "select * from public.draft_invoice_balances($1)", [id]);
const pickFrom = (by: Who, notes: string[]) => q<{ r: { invoice_id: string; subtotal: number; vat: number; total: number; lines: number } }>(
  by, "select public.create_invoice_from_delivery_notes($1::uuid[], current_date, current_date + 30, '30 days') as r", [notes]).then((r) => r[0].r);
const pickRefusal = (by: Who, notes: string[]) => refusal(by, "select public.create_invoice_from_delivery_notes($1::uuid[], current_date, current_date + 30, '30 days')", [notes]);

type Sent = { description: string; quantity: number; unit_price: number; vat_pct: number; vat_exempt: boolean; sales_order_line_id?: string | null };
/** What the editor sends for `invoiceId` (replace_draft_invoice) with each line's quantity changed by `qty` (and its link as stored). */
async function editorSave(by: Who, invoiceId: string, qty: (l: { description: string; quantity: number }) => number, opts: { links?: boolean; relink?: string; add?: Sent[]; drop?: string } = {}) {
  const ls = (await lines(invoiceId)).filter((l) => l.description !== opts.drop);
  const sent: Sent[] = ls.map((l, i) => {
    const quantity = qty({ description: l.description, quantity: Number(l.quantity) });
    const base = { description: l.description, quantity, unit_price: Number(l.unit_price), vat_pct: 20, vat_exempt: false };
    if (opts.links === false) return base;
    return { ...base, sales_order_line_id: i === 0 && opts.relink ? opts.relink : l.sales_order_line_id };
  }).concat(opts.add ?? []);
  return saveLines(by, invoiceId, sent);
}
/** replace_draft_invoice with exactly these lines, the header's totals worked out as the editor does. */
async function saveLines(by: Who, invoiceId: string, sent: Sent[]) {
  // updated_at as text: the token keeps its microseconds (a JS Date would drop them and read as changed).
  const inv = await one<{ updated_at: string; vat_enabled: boolean }>("select updated_at::text as updated_at, vat_enabled from public.invoices where id = $1", [invoiceId]);
  const net = sent.reduce((s, l) => s + Math.round(l.quantity * l.unit_price * 100) / 100, 0);
  const vat = sent.reduce((s, l) => s + Math.round(Math.round(l.quantity * l.unit_price * 100) / 100 * 20) / 100, 0);
  const n = Math.round(net * 100) / 100;
  const v = inv.vat_enabled ? Math.round(vat * 100) / 100 : 0;
  const header = { description: sent[0].description, quantity: sent[0].quantity, unit_price: sent[0].unit_price, subtotal: n, vat: v, total: Math.round((n + v) * 100) / 100, carriage: 0 };
  return refusal(by, "select public.replace_draft_invoice($1, $2, $3::jsonb, $4::jsonb)", [invoiceId, inv.updated_at, JSON.stringify(header), JSON.stringify(sent)]);
}

describe("a full despatch", () => {
  it("drafts the order's full quantities, each line linked to its order line, to the penny", async () => {
    const o = await order();
    const note = await despatch(o, [[o.flange, 12], [o.bush, 7]]);
    const inv = (await noteInvoice(note))!;
    expect(inv).toBeTruthy();
    expect((await lines(inv)).map((l) => [l.description, Number(l.quantity), l.sales_order_line_id])).toEqual([["Flange 80mm", 12, o.flange], ["Bush 25mm", 7, o.bush]]);
    expect(await invoice(inv)).toMatchObject({ status: "draft", invoice_ref: null, subtotal: "1900.03", vat: "380.01", total: "2280.04" });
    expect((await balances(who("office"), inv)).map((b) => [b.sales_order_line_id, Number(b.despatched), Number(b.on_other_invoices), Number(b.available)]))
      .toEqual([[o.flange, 12, 0, 12], [o.bush, 7, 0, 7]]);
  });
});

describe("a part despatch, then a second part", () => {
  it("without a job: each note drafts only what it took; together they make the order exactly", async () => {
    const o = await order();
    const first = await despatch(o, [[o.flange, 5]]);
    const second = await despatch(o, [[o.flange, 7], [o.bush, 7]]);
    const a = (await noteInvoice(first))!;
    const b = (await noteInvoice(second))!;
    expect(a).not.toBe(b);
    expect(await short(a)).toEqual([["Flange 80mm", 5]]);
    expect(await short(b)).toEqual([["Flange 80mm", 7], ["Bush 25mm", 7]]);
    expect(Number((await invoice(a)).subtotal) + Number((await invoice(b)).subtotal)).toBeCloseTo(1900.03, 2);
    expect((await invoice(a)).subtotal).toBe("750.00");
  });

  it("with a job: Finish with nothing despatched drafts nothing (open question branch); the parts go on the job's draft, then a new draft once it is issued; the issued one is untouched", async () => {
    const j = await orderJob();
    await complete(j.jobId);
    expect(await jobInvoices(j.jobId)).toEqual([]);
    const job = await one<{ n: string }>("select count(*) as n from security_audit.audit_log where action = 'JOB_DRAFT_INVOICE' and entity_id = $1", [j.jobId]);
    expect(Number(job.n)).toBe(0);
    // Meanwhile the dashboard lists it: Complete, 19 to despatch (12 + 7), nothing to invoice. The workshop doesn't read this list.
    expect(await awaiting(j.jobId)).toEqual([{ toDespatch: 19, toInvoice: 0 }]);
    expect(await refusal(who("workshop"), "select * from public.jobs_awaiting_despatch_or_invoice()")).toMatchObject({ code: "42501" });

    const n1 = await despatch(j, [[j.flange, 5]]);
    const draft = (await noteInvoice(n1))!;
    expect(await short(draft)).toEqual([["Flange 80mm", 5]]);
    expect((await invoice(draft)).subtotal).toBe("750.00");
    expect(await awaiting(j.jobId)).toEqual([{ toDespatch: 14, toInvoice: 0 }]);
    const n2 = await despatch(j, [[j.flange, 4], [j.bush, 7]]);
    expect(await noteInvoice(n2)).toBe(draft);
    expect(await jobInvoices(j.jobId)).toHaveLength(1);
    expect((await lines(draft)).map((l) => [l.description, Number(l.quantity), l.sales_order_line_id])).toEqual([["Flange 80mm", 9, j.flange], ["Bush 25mm", 7, j.bush]]);
    // 9 x 150 = 1350.00 + 100.03; VAT 270.00 + 20.01.
    expect(await invoice(draft)).toMatchObject({ subtotal: "1450.03", vat: "290.01", total: "1740.04" });

    const ref = (await q<{ r: string }>(who("office"), "select public.issue_invoice($1) as r", [draft]))[0].r;
    expect(ref).toMatch(/^INV-/);
    const issuedBefore = { head: await invoice(draft), lines: await lines(draft) };
    const n3 = await despatch(j, [[j.flange, 3]]);
    const next = (await noteInvoice(n3))!;
    expect(next).not.toBe(draft);
    expect(await short(next)).toEqual([["Flange 80mm", 3]]);
    expect(await invoice(next)).toMatchObject({ status: "draft", subtotal: "450.00", vat: "90.00", total: "540.00" });
    expect({ head: await invoice(draft), lines: await lines(draft) }).toEqual(issuedBefore);
    // Everything ordered is now on exactly one invoice: 9 + 3 flanges, 7 bushes.
    const billed = await rows<{ id: string; q: string }>(
      "select l.sales_order_line_id as id, sum(l.quantity) as q from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id where i.job_id = $1 group by 1", [j.jobId]);
    expect(Object.fromEntries(billed.map((b) => [b.id, Number(b.q)]))).toEqual({ [j.flange]: 12, [j.bush]: 7 });
    // Nothing is left: the manual picker has nothing to bill, and the dashboard no longer lists the job.
    expect(await pickRefusal(who("office"), [n3])).toMatchObject({ code: "22023" });
    expect(await awaiting(j.jobId)).toEqual([]);
    // Taking the flanges off the last draft lists it again as despatched and not invoiced.
    expect(await editorSave(who("office"), next, () => 1)).toBeNull();
    expect(await awaiting(j.jobId)).toEqual([{ toDespatch: 0, toInvoice: 2 }]);
  });
});

describe("editing a draft: never more than despatched and not invoiced elsewhere", () => {
  async function twoDrafts() {
    const o = await order();
    const a = (await noteInvoice(await despatch(o, [[o.flange, 5]])))!;
    const b = (await noteInvoice(await despatch(o, [[o.flange, 3]])))!;
    return { o, a, b };
  }

  it("the editor's read shows the balance; more is refused with a clear message, up to it and less are saved", async () => {
    const { o, b } = await twoDrafts();
    expect((await balances(who("admin"), b)).map((x) => [Number(x.ordered), Number(x.despatched), Number(x.on_other_invoices), Number(x.available)])).toEqual([[12, 8, 5, 3]]);
    const over = await editorSave(who("office"), b, () => 4);
    expect(over).toMatchObject({ code: "22023", hint: "over_despatched" });
    expect(over!.message).toBe('"Flange 80mm": 8 despatched, 5 already on other invoices, so this invoice can bill at most 3 (it has 4). The rest is billed when it is despatched.');
    expect(await short(b)).toEqual([["Flange 80mm", 3]]);
    expect(await editorSave(who("office"), b, () => 2)).toBeNull();
    expect(await editorSave(who("office"), b, () => 3)).toBeNull();
    expect((await lines(b))[0].sales_order_line_id).toBe(o.flange);
    expect(await editorSave(who("office"), b, () => 3.001)).toMatchObject({ code: "22023", hint: "over_despatched" });
  });

  it("the editor keeps links: an old screen's save (no links) and a link to another order's line are refused", async () => {
    const { o, b } = await twoDrafts();
    const other = await order();
    expect(await editorSave(who("office"), b, () => 3, { links: false })).toMatchObject({ code: "22023", hint: "reload_needed" });
    expect(await editorSave(who("office"), b, () => 1, { relink: other.flange })).toMatchObject({ code: "22023", hint: "order_link_kept" });
    // A line of the draft's own order is allowed, but only for what is despatched (no bush has gone out).
    expect(await editorSave(who("office"), b, () => 1, { relink: o.bush })).toMatchObject({ code: "22023", hint: "over_despatched" });
    expect((await lines(b)).map((l) => l.sales_order_line_id)).toEqual([o.flange]);
  });

  it("direct writes are held to the same rule: more quantity, a new linked line, and changing or removing the link are refused", async () => {
    const { o, a, b } = await twoDrafts();
    const [line] = await lines(b);
    expect(await refusal(who("office"), "update public.invoice_line_items set quantity = 4 where id = $1", [line.id])).toMatchObject({ code: "22023", hint: "over_despatched" });
    expect(await refusal(who("office"), "update public.invoice_line_items set sales_order_line_id = null where id = $1", [line.id])).toMatchObject({ code: "22023", hint: "order_link_kept" });
    expect(await refusal(who("office"), "update public.invoice_line_items set sales_order_line_id = $2 where id = $1", [line.id, o.bush])).toMatchObject({ code: "22023", hint: "order_link_kept" });
    expect(await refusal(who("office"), "insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, sales_order_line_id) values ($1, $2, 5, 'Flange 80mm', 1, 150, $3)",
      [alpha().id, a, o.flange])).toMatchObject({ code: "42501", hint: "order_link_by_drafting" });
    // The database owner is held to it too (it's not a role check).
    await expect(rows("update public.invoice_line_items set quantity = 9 where id = $1", [line.id])).rejects.toMatchObject({ code: "22023" });
    expect(await short(b)).toEqual([["Flange 80mm", 3]]);
  });

  it("reducing an unissued draft frees the quantity: the editor shows it, and a reduction racing a raise is serialised", async () => {
    const { o, a, b } = await twoDrafts();
    // b may take only what is not on a (8 despatched, 5 on a).
    expect(Number((await balances(who("office"), b))[0].available)).toBe(3);
    expect(await editorSave(who("office"), a, () => 3)).toBeNull();
    // a now bills 3 of its note's 5: 2 are free, and b's balance says so.
    expect(Number((await balances(who("office"), b))[0].available)).toBe(5);
    // Race: a reduction (a: 3 -> 1) holds the order line's lock; a raise of b to 7 waits for it, then sees the 2 it freed.
    const r = await withDb((watch) => withDb((x) => withDb(async (y) => {
      await x.query("begin");
      await become(x, who("office"));
      await x.query("update public.invoice_line_items set quantity = 1 where invoice_id = $1 and sales_order_line_id = $2", [a, o.flange]);
      await y.query("begin");
      await become(y, who("admin"));
      const pid = (await y.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
      const pending = y.query("update public.invoice_line_items set quantity = 7 where invoice_id = $1 and sales_order_line_id = $2", [b, o.flange]).then(() => null, (e: { code?: string; hint?: string }) => e);
      let waited = false;
      for (let i = 0; i < 500 && !waited; i += 1) {
        waited = (await watch.query<{ t: string | null }>("select wait_event_type as t from pg_stat_activity where pid = $1", [pid])).rows[0]?.t === "Lock";
        if (!waited) await sleep(10);
      }
      await x.query("commit");
      const second = await pending;
      await y.query(second ? "rollback" : "commit");
      return { waited, second };
    })));
    expect(r).toEqual({ waited: true, second: null });
    expect(await short(a)).toEqual([["Flange 80mm", 1]]);
    expect(await short(b)).toEqual([["Flange 80mm", 7]]);
    // Exactly what went out is billed: 1 + 7 = 8; nothing more fits.
    expect(await editorSave(who("office"), a, () => 2)).toMatchObject({ code: "22023", hint: "over_despatched" });
  });

  it("deleting a line of an unissued draft frees it; the next draft of the order takes it (as the next delivery note goes out)", async () => {
    const o = await order();
    const d1 = (await noteInvoice(await despatch(o, [[o.flange, 5], [o.bush, 7]])))!;
    // The bushes are taken off this draft (and it is issued without them): 7 bushes are despatched and not invoiced.
    expect(await editorSave(who("office"), d1, (l) => l.quantity, { drop: "Bush 25mm" })).toBeNull();
    expect(await short(d1)).toEqual([["Flange 80mm", 5]]);
    // The next note (2 flanges) drafts its flanges plus the 7 freed bushes, linked.
    const d2 = (await noteInvoice(await despatch(o, [[o.flange, 2]])))!;
    expect((await lines(d2)).map((l) => [l.description, Number(l.quantity), l.sales_order_line_id])).toEqual([["Flange 80mm", 2, o.flange], ["Bush 25mm", 7, o.bush]]);
    expect(await invoice(d2)).toMatchObject({ subtotal: "400.03", vat: "80.01", total: "480.04" });
    // Freed again (the bushes off d2): the editor of d1 offers them, and adding them there is allowed.
    expect(await editorSave(who("office"), d2, (l) => l.quantity, { drop: "Bush 25mm" })).toBeNull();
    const offered = (await balances(who("office"), d1)).filter((b) => b.line_position === null);
    expect(offered.map((b) => [b.sales_order_line_id, Number(b.available)])).toEqual([[o.bush, 7]]);
    expect(await editorSave(who("office"), d1, (l) => l.quantity, { add: [{ description: "Bush 25mm", quantity: 8, unit_price: 14.29, vat_pct: 20, vat_exempt: false, sales_order_line_id: o.bush }] }))
      .toMatchObject({ code: "22023", hint: "over_despatched" });
    expect(await editorSave(who("office"), d1, (l) => l.quantity, { add: [{ description: "Bush 25mm", quantity: 7, unit_price: 14.29, vat_pct: 20, vat_exempt: false, sales_order_line_id: o.bush }] })).toBeNull();
    expect((await lines(d1)).map((l) => [l.description, Number(l.quantity), l.sales_order_line_id])).toEqual([["Flange 80mm", 5, o.flange], ["Bush 25mm", 7, o.bush]]);
    // Everything that went out is on exactly one live invoice: 5 + 2 flanges, 7 bushes.
    const billed = await rows<{ id: string; q: string }>(
      "select l.sales_order_line_id as id, sum(l.quantity) as q from public.invoice_line_items l where l.invoice_id = any($1::uuid[]) group by 1", [[d1, d2]]);
    expect(Object.fromEntries(billed.map((b) => [b.id, Number(b.q)]))).toEqual({ [o.flange]: 7, [o.bush]: 7 });
  });

  it("two writers taking the same outstanding quantity at once: the second waits, then is refused", async () => {
    const { o, a, b } = await twoDrafts();
    // Two more flanges go out with no draft (an owner's change): outstanding 2, and each draft alone could take them.
    await despatchedByOwner(o, [[o.flange, 2]]);
    const bump = "update public.invoice_line_items set quantity = quantity + 2 where invoice_id = $1 and sales_order_line_id = $2";
    const r = await withDb((watch) => withDb((x) => withDb(async (y) => {
      await x.query("begin");
      await become(x, who("office"));
      await x.query(bump, [a, o.flange]);
      await y.query("begin");
      await become(y, who("admin"));
      const pid = (await y.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
      const pending = y.query(bump, [b, o.flange]).then(() => null, (e: { code?: string; hint?: string }) => e);
      let waited = false;
      for (let i = 0; i < 500 && !waited; i += 1) {
        waited = (await watch.query<{ t: string | null }>("select wait_event_type as t from pg_stat_activity where pid = $1", [pid])).rows[0]?.t === "Lock";
        if (!waited) await sleep(10);
      }
      await x.query("commit");
      const second = await pending;
      await y.query("rollback");
      return { waited, second };
    })));
    expect(r.waited).toBe(true);
    expect(r.second).toMatchObject({ code: "22023", hint: "over_despatched" });
    expect(await short(a)).toEqual([["Flange 80mm", 7]]);
    expect(await short(b)).toEqual([["Flange 80mm", 3]]);
  });
});

describe("order lines and manual lines (099)", () => {
  it("a line is 'order' (linked) or 'manual' (tooling, carriage: never linked); only the drafting functions link; the kind never changes", async () => {
    const o = await order();
    const d = (await noteInvoice(await despatch(o, [[o.flange, 2]])))!;
    expect((await rows<{ line_kind: string }>("select line_kind from public.invoice_line_items where invoice_id = $1", [d]))).toEqual([{ line_kind: "order" }]);
    // A carriage line typed in the editor: manual, saved.
    expect(await editorSave(who("office"), d, (l) => l.quantity, { add: [{ description: "Carriage (pallet)", quantity: 1, unit_price: 35, vat_pct: 20, vat_exempt: false, sales_order_line_id: null }] })).toBeNull();
    expect(await rows("select description, line_kind, sales_order_line_id from public.invoice_line_items where invoice_id = $1 order by position", [d]))
      .toEqual([{ description: "Flange 80mm", line_kind: "order", sales_order_line_id: o.flange }, { description: "Carriage (pallet)", line_kind: "manual", sales_order_line_id: null }]);
    // Tooling on a hand-made invoice through create_with_lines: manual, allowed. The same call carrying an order link is refused.
    const lineOf = (link: string | null) => JSON.stringify([{ description: "Tooling charge", quantity: 1, unit_price: 250, vat_pct: 20, vat_exempt: false, ...(link ? { sales_order_line_id: link } : {}) }]);
    const head = JSON.stringify({ customer: "Part Co", status: "draft", subtotal: 250, vat: 50, total: 300, carriage: 0, vat_enabled: true, invoice_date: "2026-10-27", due_date: "2026-11-26" });
    const made = (await q<{ r: string }>(who("office"), "select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as r", [head, lineOf(null)]))[0].r;
    expect(await rows("select line_kind from public.invoice_line_items where invoice_id = $1", [made])).toEqual([{ line_kind: "manual" }]);
    expect(await refusal(who("office"), "select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb)", [head, lineOf(o.flange)]))
      .toMatchObject({ code: "42501", hint: "order_link_by_drafting" });
    // Declared kinds can't be forged either way, by any role, and a kind never changes.
    expect(await refusal(who("admin"), "insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, line_kind) values ($1, $2, 9, 'x', 1, 1, 'order')", [alpha().id, made]))
      .toMatchObject({ code: "22023", hint: "order_line_needs_link" });
    await expect(rows("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, sales_order_line_id) values ($1, $2, 9, 'x', 1, 150, $3)", [alpha().id, made, o.flange]))
      .rejects.toMatchObject({ code: "42501" });
    expect(await refusal(who("office"), "update public.invoice_line_items set line_kind = 'order' where invoice_id = $1", [made])).toMatchObject({ code: "22023", hint: "order_link_kept" });
  });

  it("an invoice made before 099 keeps counting its notes (reducing it frees nothing) and is offered nothing to add", async () => {
    const o = await order();
    const note = await despatchedByOwner(o, [[o.flange, 4]]);
    // As 059 made it before 099: one unlinked line for the note, the note on it, and in the notes snapshot.
    const legacy = await one<{ id: string }>(
      `insert into public.invoices (organization_id, customer, status, subtotal, vat, total, carriage, vat_enabled, carriage_vat, amount_paid, invoice_date, due_date, description, quantity, unit_price)
       values ($1, 'Part Co', 'draft', 600, 120, 720, 0, true, true, 0, current_date, current_date + 30, 'Flange 80mm', 4, 150) returning id`, [alpha().id]);
    await rows("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt, line_kind) values ($1, $2, 0, 'Flange 80mm', 4, 150, 20, false, null)", [alpha().id, legacy.id]);
    await rows("update public.delivery_notes set invoice_id = $1 where id = $2", [legacy.id, note]);
    await rows("insert into public.invoice_notes_legacy (invoice_id, organization_id) values ($1, $2)", [legacy.id, alpha().id]);
    expect(await editorSave(who("office"), legacy.id, () => 1)).toBeNull();
    expect(await balances(who("office"), legacy.id)).toEqual([expect.objectContaining({ line_position: 0, sales_order_line_id: null })]);
    // Still counted at its note's 4: a picker for the note is refused, and the next note drafts only its own.
    expect(await pickRefusal(who("office"), [note])).toMatchObject({ code: "22023" });
    const next = (await noteInvoice(await despatch(o, [[o.flange, 3]])))!;
    expect(await short(next)).toEqual([["Flange 80mm", 3]]);
  });
});

describe("the delivery note path and Job Finish never bill the same quantity twice", () => {
  it("a note out before Finish (owner's change): Finish drafts exactly it and takes the note; the picker can't bill it again", async () => {
    const j = await orderJob();
    const n1 = await despatchedByOwner(j, [[j.flange, 5]]);
    await finish(j.jobId);
    const [draft] = await jobInvoices(j.jobId);
    expect(await short(draft.id)).toEqual([["Flange 80mm", 5]]);
    expect((await lines(draft.id))[0].sales_order_line_id).toBe(j.flange);
    expect(await invoice(draft.id)).toMatchObject({ status: "draft", subtotal: "750.00", vat: "150.00", total: "900.00" });
    expect(await noteInvoice(n1)).toBe(draft.id);
    expect(await pickRefusal(who("office"), [n1])).toMatchObject({ code: "22023" });
    // A second note while the job has its draft: the picker can't make a second draft for the job.
    const n2 = await despatchedByOwner(j, [[j.flange, 4]]);
    expect(await pickRefusal(who("office"), [n2])).toMatchObject({ code: "22023", hint: "job_has_draft" });
    // Complete and issued: the picker bills the second note, exactly.
    await q(who("office"), INSPECT_SQL, [j.jobId]);
    await q(who("office"), "select public.issue_invoice($1)", [draft.id]);
    const made = await pickFrom(who("office"), [n2]);
    expect(await short(made.invoice_id)).toEqual([["Flange 80mm", 4]]);
    expect(Number(made.subtotal)).toBe(600);
  });

  it("a note picked onto a draft before Finish: Finish makes no second draft", async () => {
    const j = await orderJob();
    const n1 = await despatchedByOwner(j, [[j.flange, 6]]);
    const made = await pickFrom(who("office"), [n1]);
    await finish(j.jobId);
    expect((await jobInvoices(j.jobId)).map((i) => i.id)).toEqual([made.invoice_id]);
    expect(await short(made.invoice_id)).toEqual([["Flange 80mm", 6]]);
  });

  it("a Job Finish draft made before 099 (full order, unlinked) counts the whole order: later notes go on it and add nothing; issued, they still bill nothing", async () => {
    const j = await orderJob();
    await finish(j.jobId);
    // What 081 made at Finish: the order's full quantities, unlinked, and its audit event (as before 099).
    const legacy = await one<{ id: string }>(
      `insert into public.invoices (organization_id, customer, job_id, status, subtotal, vat, total, carriage, vat_enabled, carriage_vat, amount_paid, invoice_date, due_date, description, quantity, unit_price)
       values ($1, 'Part Co', $2, 'draft', 1900.03, 380.01, 2280.04, 0, true, true, 0, current_date, current_date + 30, 'Flange 80mm', 12, 150) returning id`, [alpha().id, j.jobId]);
    for (const [position, l] of LINES.entries()) {
      await rows("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, $3, $4, $5, $6, 20, false)",
        [alpha().id, legacy.id, position, l.description, l.quantity, l.unit_price]);
    }
    await rows("insert into security_audit.audit_log (organization_id, action, entity_table, entity_id, metadata) values ($1, 'JOB_DRAFT_INVOICE', 'jobs', $2, $3::jsonb)",
      [alpha().id, j.jobId, JSON.stringify({ outcome: "drafted", invoice_id: legacy.id, sales_order_id: j.orderId })]);
    // The release's backfill statement (section 3 of the migration), run again: it finds this draft from the audit log.
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/099_part_despatch_invoice_quantity.sql"), "utf8");
    const start = sql.indexOf("INSERT INTO public.invoice_job_finish_legacy");
    await rows(sql.slice(start, sql.indexOf(";", start) + 1));
    expect(await rows("select sales_order_id from public.invoice_job_finish_legacy where invoice_id = $1", [legacy.id])).toEqual([{ sales_order_id: j.orderId }]);

    await q(who("office"), INSPECT_SQL, [j.jobId]);
    const before = { head: await invoice(legacy.id), lines: await lines(legacy.id) };
    const n1 = await despatch(j, [[j.flange, 5]]);
    expect(await noteInvoice(n1)).toBe(legacy.id);
    expect({ head: await invoice(legacy.id), lines: await lines(legacy.id) }).toEqual({ ...before, head: { ...before.head, updated_at: expect.any(Date) } });
    expect(await jobInvoices(j.jobId)).toHaveLength(1);
    await q(who("office"), "select public.issue_invoice($1)", [legacy.id]);
    const issued = { head: await invoice(legacy.id), lines: await lines(legacy.id) };
    const n2 = await despatch(j, [[j.flange, 7], [j.bush, 7]]);
    expect(await noteInvoice(n2)).toBe(legacy.id);
    expect(await jobInvoices(j.jobId)).toHaveLength(1);
    expect({ head: await invoice(legacy.id), lines: await lines(legacy.id) }).toEqual(issued);
  });
});

describe("freed quantity: a delete racing a raise, a job's draft, and what is never changed (099)", () => {
  /** Every live invoice line billing `line`, added up (what the order line is billed for). */
  const billedFor = async (line: string) => Number((await one<{ q: string | null }>(
    `select sum(l.quantity) as q from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id
     where l.sales_order_line_id = $1 and lower(coalesce(i.status, 'draft')) not in ('void', 'voided', 'cancelled', 'canceled')`, [line])).q ?? 0);
  /** Runs `first` in an open transaction, then `second` in another, which must wait on the order line's lock; commits the first, then the second. */
  async function interleave(first: [Who, string, unknown[]], second: [Who, string, unknown[]]) {
    return withDb((watch) => withDb((x) => withDb(async (y) => {
      await x.query("begin");
      await become(x, first[0]);
      await x.query(first[1], first[2]);
      await y.query("begin");
      await become(y, second[0]);
      const pid = (await y.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
      const pending = y.query(second[1], second[2]).then(() => null, (e: { code?: string; hint?: string }) => e);
      let waited = false;
      for (let i = 0; i < 500 && !waited; i += 1) {
        waited = (await watch.query<{ t: string | null }>("select wait_event_type as t from pg_stat_activity where pid = $1", [pid])).rows[0]?.t === "Lock";
        if (!waited) await sleep(10);
      }
      await x.query("commit");
      const out = await pending;
      await y.query(out ? "rollback" : "commit");
      return { waited, second: out };
    })));
  }

  it("a delete racing a raise on the same order line: the raise waits, then takes exactly what the delete freed; never more than went out, nothing lost", async () => {
    const o = await order();
    const a = (await noteInvoice(await despatch(o, [[o.flange, 5]])))!;
    const b = (await noteInvoice(await despatch(o, [[o.flange, 3]])))!;
    // Raise first, delete second: the raise is refused at once (a still bills 5), and the delete then frees 5.
    expect(await refusal(who("admin"), "update public.invoice_line_items set quantity = 8 where invoice_id = $1", [b])).toMatchObject({ code: "22023", hint: "over_despatched" });
    // Delete first (holding the lock), raise second: the raise waits for the delete, then sees the 5 it freed and takes them.
    const r = await interleave(
      [who("office"), "delete from public.invoice_line_items where invoice_id = $1 and sales_order_line_id = $2", [a, o.flange]],
      [who("admin"), "update public.invoice_line_items set quantity = 8 where invoice_id = $1 and sales_order_line_id = $2", [b, o.flange]]);
    expect(r).toEqual({ waited: true, second: null });
    expect(await short(a)).toEqual([]);
    expect(await short(b)).toEqual([["Flange 80mm", 8]]);
    // Billed = despatched = 8 (of 12 ordered): nothing over, nothing lost. A third writer can't add any.
    expect(await billedFor(o.flange)).toBe(8);
    expect(await refusal(who("office"), "update public.invoice_line_items set quantity = 9 where invoice_id = $1", [b])).toMatchObject({ code: "22023", hint: "over_despatched" });
    // The other way round, a raise holding the lock first and a delete waiting: the raise (to what is free) goes first, the delete then.
    const c = (await noteInvoice(await despatch(o, [[o.flange, 2]])))!;
    expect(await billedFor(o.flange)).toBe(10);
    await q(who("office"), "update public.invoice_line_items set quantity = 6 where invoice_id = $1", [b]); // 2 free
    expect(await billedFor(o.flange)).toBe(8);
    const r2 = await interleave(
      [who("admin"), "update public.invoice_line_items set quantity = 8 where invoice_id = $1 and sales_order_line_id = $2", [b, o.flange]],
      [who("office"), "delete from public.invoice_line_items where invoice_id = $1 and sales_order_line_id = $2", [c, o.flange]]);
    expect(r2).toEqual({ waited: true, second: null });
    expect(await short(b)).toEqual([["Flange 80mm", 8]]);
    expect(await short(c)).toEqual([]);
    expect(await billedFor(o.flange)).toBe(8);
  });

  it("freed on a JOB's draft, then the next note goes on that same draft: it takes the note and the freed quantity, once", async () => {
    const j = await orderJob();
    await complete(j.jobId);
    const n1 = await despatch(j, [[j.flange, 5], [j.bush, 7]]);
    const draft = (await noteInvoice(n1))!;
    expect(await short(draft)).toEqual([["Flange 80mm", 5], ["Bush 25mm", 7]]);
    // Bushes reduced to 3 (4 freed), flanges deleted (5 freed), on the job's unissued draft.
    expect(await editorSave(who("office"), draft, (l) => (l.description === "Bush 25mm" ? 3 : l.quantity), { drop: "Flange 80mm" })).toBeNull();
    expect(await short(draft)).toEqual([["Bush 25mm", 3]]);
    expect(await billedFor(j.flange)).toBe(0);
    expect(await billedFor(j.bush)).toBe(3);
    // The next note (2 flanges) goes on the job's draft (one draft per job) through invoice_add_delivery_note, adding the 2 it took
    // plus the 5 flanges and 4 bushes freed: exactly what went out, once.
    const n2 = await despatch(j, [[j.flange, 2]]);
    expect(await noteInvoice(n2)).toBe(draft);
    expect(await jobInvoices(j.jobId)).toHaveLength(1);
    expect((await lines(draft)).map((l) => [l.description, Number(l.quantity), l.sales_order_line_id])).toEqual([["Bush 25mm", 7, j.bush], ["Flange 80mm", 7, j.flange]]);
    expect(await billedFor(j.flange)).toBe(7);
    expect(await billedFor(j.bush)).toBe(7);
    // 7 x 150 + 7 x 14.29 = 1050.00 + 100.03; VAT 210.00 + 20.01.
    expect(await invoice(draft)).toMatchObject({ subtotal: "1150.03", vat: "230.01", total: "1380.04" });
    // A further note adds only itself; nothing is billed twice.
    const n3 = await despatch(j, [[j.flange, 1]]);
    expect(await noteInvoice(n3)).toBe(draft);
    expect(await billedFor(j.flange)).toBe(8);
    expect(await billedFor(j.bush)).toBe(7);
  });

  it("issued invoices and invoices made before 099 are never changed: not by these flows, and not by running the release again", async () => {
    // An issued invoice (from a full despatch) and a pre-099 invoice (unlinked, its note in the snapshot), both on orders the flows below touch.
    const o = await order();
    const issued = (await noteInvoice(await despatch(o, [[o.flange, 4], [o.bush, 7]])))!;
    await q(who("office"), "select public.issue_invoice($1)", [issued]);
    const old = await order();
    const oldNote = await despatchedByOwner(old, [[old.flange, 6]]);
    const legacy = await one<{ id: string }>(
      `insert into public.invoices (organization_id, customer, status, subtotal, vat, total, carriage, vat_enabled, carriage_vat, amount_paid, invoice_date, due_date, description, quantity, unit_price)
       values ($1, 'Part Co', 'draft', 900, 180, 1080, 0, true, true, 0, current_date, current_date + 30, 'Flange 80mm', 6, 150) returning id`, [alpha().id]);
    await rows("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Flange 80mm', 6, 150, 20, false)", [alpha().id, legacy.id]);
    await rows("update public.delivery_notes set invoice_id = $1 where id = $2", [legacy.id, oldNote]);
    await rows("insert into public.invoice_notes_legacy (invoice_id, organization_id) values ($1, $2)", [legacy.id, alpha().id]);
    const snapshot = async () => ({
      heads: await rows("select id, status, invoice_ref, subtotal, vat, total, issued_at from public.invoices where id = any($1::uuid[]) order by id", [[issued, legacy.id]]),
      lines: await rows("select invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt, sales_order_line_id, line_kind from public.invoice_line_items where invoice_id = any($1::uuid[]) order by invoice_id, position, id", [[issued, legacy.id]]),
      notes: await rows("select id, invoice_id from public.delivery_notes where invoice_id = any($1::uuid[]) order by id", [[issued, legacy.id]]),
    });
    const before = await snapshot();
    // The flows: more despatched on both orders (new drafts), a reduction and a delete on those drafts, the editor offering freed quantity.
    const d1 = (await noteInvoice(await despatch(o, [[o.flange, 3]])))!;
    expect(await editorSave(who("office"), d1, () => 1)).toBeNull();
    const d2 = (await noteInvoice(await despatch(old, [[old.flange, 2]])))!;
    expect(await short(d2)).toEqual([["Flange 80mm", 2]]);
    expect(await editorSave(who("office"), d1, (l) => l.quantity, { add: [{ description: "Flange 80mm", quantity: 2, unit_price: 150, vat_pct: 20, vat_exempt: false, sales_order_line_id: o.flange }] }))
      .toBeNull();
    await rows("delete from public.invoices where id = $1", [d2]);
    expect(await snapshot()).toEqual(before);
    // The release run again (it is safe to re-run): it takes no new snapshot and changes no stored row.
    const notesSnapshot = await rows("select invoice_id from public.invoice_notes_legacy order by invoice_id");
    const finishSnapshot = await rows("select invoice_id from public.invoice_job_finish_legacy order by invoice_id");
    await withDb((db) => db.query(readFileSync(path.resolve(__dirname, "../../supabase/release/099_part_despatch_invoice_quantity.release.sql"), "utf8")));
    expect(await snapshot()).toEqual(before);
    expect(await rows("select invoice_id from public.invoice_notes_legacy order by invoice_id")).toEqual(notesSnapshot);
    expect(await rows("select invoice_id from public.invoice_job_finish_legacy order by invoice_id")).toEqual(finishSnapshot);
  });
});

describe("another company", () => {
  it("can't read the balances of, edit, or link to this company's drafts and order lines; nobody reads the legacy table", async () => {
    const o = await order();
    const draft = (await noteInvoice(await despatch(o, [[o.flange, 2]])))!;
    expect(await refusal(betaAdmin(), "select * from public.draft_invoice_balances($1)", [draft])).toMatchObject({ code: "P0002" });
    const inv = await one<{ updated_at: Date }>("select updated_at from public.invoices where id = $1", [draft]);
    expect(await refusal(betaAdmin(), "select public.replace_draft_invoice($1, $2, '{}'::jsonb, $3::jsonb)",
      [draft, inv.updated_at, JSON.stringify([{ description: "x", quantity: 1, unit_price: 1, sales_order_line_id: o.flange }])])).toMatchObject({ code: "P0002" });
    // Beta's own draft, a line pointing at alpha's order line: refused by the same-company check.
    const betaOrg = world.tenants.beta.id;
    const betaInv = await one<{ id: string }>("insert into public.invoices (organization_id, customer, status) values ($1, 'Beta Co', 'draft') returning id", [betaOrg]);
    expect(await refusal(betaAdmin(), "insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, sales_order_line_id) values ($1, $2, 0, 'x', 1, 1, $3)",
      [betaOrg, betaInv.id, o.flange])).toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) });
    for (const p of [betaAdmin(), who("admin"), who("office")]) {
      expect(await refusal(p, "select * from public.invoice_job_finish_legacy")).toMatchObject({ code: "42501" });
    }
    for (const role of ["workshop", "viewer"] as const) {
      expect(await refusal(who(role), "select * from public.draft_invoice_balances($1)", [draft]), role).toMatchObject({ code: "42501" });
    }
    expect(await short(draft)).toEqual([["Flange 80mm", 2]]);
  });
});
