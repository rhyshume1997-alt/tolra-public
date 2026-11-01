/**
 * Migration 123: the customer's PO on the quote (decision 16). The quote carries it; accepting with the dialog empty takes it to the order,
 * the job and the draft invoice; a PO added later on the quote (set_quote_customer_po) reaches the order, the unfinished job and DRAFT
 * invoices, never an issued one; a sent quote is still frozen for every other field. The same proof for plain PostgreSQL with
 * stand-ins: tests/scripts/sql/123_quote_customer_po.proof.sql.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const as = {} as Record<"office" | "workshop", SupabaseClient>;
let seq = 0;
const org = () => world.tenants.alpha.id;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["office", "workshop"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A sent quote, VAT off, one line of 100.00 (stored total 100.00), with the customer PO given (or none). */
async function quote(po: string | null, tenant: "alpha" | "beta" = "alpha") {
  seq += 1;
  const service = adminClient();
  const organization = world.tenants[tenant].id;
  const ref = `QPO-${world.runId}-${seq}`;
  const { data, error } = await service.from("quotes").insert({ organization_id: organization, quote_ref: ref, customer: `PO Co ${seq}`, status: "draft", total_value: 100, vat_enabled: false, customer_po: po }).select("id").single();
  if (error) throw new Error(error.message);
  const { error: lineError } = await service.from("quote_line_items").insert({ organization_id: organization, quote_id: data.id, position: 0, description: "Bush", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false });
  if (lineError) throw new Error(lineError.message);
  const { error: sentError } = await service.from("quotes").update({ status: "sent" }).eq("id", data.id);
  if (sentError) throw new Error(sentError.message);
  return { id: data.id as string, ref };
}

const accept = async (id: string, po: string | null = null) => {
  const { data, error } = await as.office.rpc("accept_quote", { p_quote: id, p_customer_po: po, p_delivery_date: null });
  if (error) throw new Error(`accept_quote: ${error.message}`);
  return data as { so_id: string; so_number: string; job_id: string; job_no: string };
};
const one = async <T,>(sql: string, args: unknown[]) => (await withDb((db) => db.query(sql, args))).rows[0] as T;
const poOf = async (table: "quotes" | "sales_orders" | "jobs" | "invoices", id: string) => (await one<{ po: string | null }>(`select customer_po as po from public.${table} where id = $1`, [id])).po;

/** As Finish then Despatch do (099 drafts what was despatched): the order's lines sent out on a note, then the Job Finish draft. */
async function finishAndDraft(orderId: string, jobId: string, customer: string) {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: world.tenants.alpha.users.office.id, role: "authenticated", aal: "aal2" })]);
      await db.query("select public.ensure_sales_order_lines($1)", [orderId]);
      await db.query("update public.jobs set started_at = now() - interval '1 hour', finished_at = now() where id = $1", [jobId]);
      const note = (await db.query<{ id: string }>(
        "insert into public.delivery_notes (organization_id, dn_number, customer, sales_order_id, job_id, status, delivery_date) values ($1, $2, $3, $4, $5, 'despatched', current_date) returning id",
        [org(), `DLN-PO-${world.runId}-${seq}`, customer, orderId, jobId])).rows[0].id;
      await db.query(`insert into public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, sales_order_line_id)
                      select l.organization_id, $1, l.position, l.description, l.quantity, l.id from public.sales_order_lines l where l.sales_order_id = $2`, [note, orderId]);
      const outcome = (await db.query<{ r: string }>("select public.job_finish_draft_invoice($1, $2) as r", [jobId, org()])).rows[0].r;
      await db.query("commit");
      return outcome;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}

/** md5 of every quotes, sales_orders, jobs and invoices row of this run's two companies, except one quote and its order. */
const fingerprint = async (quoteId: string, orderId: string) => (await one<{ fp: string }>(`select md5(string_agg(x, '|' order by x)) as fp from (
    select 'q' || row_to_json(q)::text as x from public.quotes q where q.organization_id = any($1) and q.id <> $2
    union all select 's' || row_to_json(o)::text from public.sales_orders o where o.organization_id = any($1) and o.id <> $3
    union all select 'j' || row_to_json(t)::text from public.jobs t where t.organization_id = any($1)
    union all select 'i' || row_to_json(n)::text from public.invoices n where n.organization_id = any($1)) f`,
  [[world.tenants.alpha.id, world.tenants.beta.id], quoteId, orderId])).fp;

describe("the customer's PO on the quote (123)", () => {
  it("the whole chain: quote with Customer PO 4471 -> accept (dialog empty) -> order 4471 -> job 4471 -> draft invoice 4471", async () => {
    const q = await quote("4471");
    const accepted = await accept(q.id);
    expect(await poOf("sales_orders", accepted.so_id)).toBe("4471");
    expect(await poOf("jobs", accepted.job_id)).toBe("4471");
    await finishAndDraft(accepted.so_id, accepted.job_id, `PO Co ${seq}`);
    const invoice = await one<{ id: string; status: string; po: string }>("select id, status, customer_po as po from public.invoices where job_id = $1", [accepted.job_id]);
    expect(invoice).toMatchObject({ status: "draft", po: "4471" });
  });

  it("the accept dialog's PO is used when one is given", async () => {
    const q = await quote("5000");
    const accepted = await accept(q.id, "DIALOG-1");
    expect(await poOf("sales_orders", accepted.so_id)).toBe("DIALOG-1");
  });

  it("a late PO set on the accepted quote reaches its order, unfinished job and draft invoice, once audited; the same PO again changes nothing", async () => {
    const q = await quote(null);
    const accepted = await accept(q.id);
    // A draft invoice already on the job (as Finish makes one), made by the owner.
    const draft = (await one<{ id: string }>("insert into public.invoices (organization_id, customer, job_id, status, subtotal, vat, total) values ($1, 'Late Co', $2, 'draft', 100, 0, 100) returning id", [org(), accepted.job_id])).id;
    const { data, error } = await as.office.rpc("set_quote_customer_po", { p_quote: q.id, p_customer_po: " 7788 " });
    expect(error).toBeNull();
    expect(data).toMatchObject({ changed: true, customer_po: "7788", job_updated: true, draft_invoices: 1 });
    for (const [table, id] of [["quotes", q.id], ["sales_orders", accepted.so_id], ["jobs", accepted.job_id], ["invoices", draft]] as const) expect(await poOf(table, id)).toBe("7788");
    expect(Number((await one<{ n: string }>("select count(*) as n from security_audit.audit_log where action = 'SET_CUSTOMER_PO' and entity_table = 'quotes' and entity_id = $1", [q.id])).n)).toBe(1);
    // Who changed it, from what, to what: the named event, and each row's own change (old and new values).
    const office = world.tenants.alpha.users.office.id;
    expect(await one("select actor_user_id::text as actor, metadata -> 'previous_customer_po' as previous, metadata ->> 'customer_po' as po from security_audit.audit_log where action = 'SET_CUSTOMER_PO' and entity_id = $1", [q.id]))
      .toEqual({ actor: office, previous: null, po: "7788" });
    for (const [table, id] of [["quotes", q.id], ["sales_orders", accepted.so_id], ["jobs", accepted.job_id], ["invoices", draft]] as const) {
      expect(Number((await one<{ n: string }>(`select count(*) as n from security_audit.audit_log where action = 'UPDATE' and entity_table = $1 and entity_id = $2
        and actor_user_id = $3 and old_data ->> 'customer_po' is null and new_data ->> 'customer_po' = '7788'`, [table, id, office])).n)).toBe(1);
    }
    expect((await as.office.rpc("set_quote_customer_po", { p_quote: q.id, p_customer_po: "7788" })).data).toMatchObject({ changed: false });
  });

  it("an issued invoice and a finished job keep the PO they were made with; the quote and order take the new one", async () => {
    const q = await quote("4471");
    const accepted = await accept(q.id);
    await finishAndDraft(accepted.so_id, accepted.job_id, `PO Co ${seq}`);
    const invoice = (await one<{ id: string }>("select id from public.invoices where job_id = $1", [accepted.job_id])).id;
    await withDb((db) => db.query("update public.invoices set status = 'sent', invoice_ref = $2, issued_at = now() where id = $1", [invoice, `INV-PO-${world.runId}-${seq}`]));
    // Another quote's order, job and draft invoice, and another company's quote, to prove they are not touched.
    const other = await accept((await quote("OTHER-1")).id);
    await one("insert into public.invoices (organization_id, customer, job_id, status, subtotal, vat, total, customer_po) values ($1, 'Other Co', $2, 'draft', 100, 0, 100, 'OTHER-1') returning id", [org(), other.job_id]);
    await quote("B-PO", "beta");
    const before = await fingerprint(q.id, accepted.so_id);
    const { data, error } = await as.office.rpc("set_quote_customer_po", { p_quote: q.id, p_customer_po: "4472" });
    expect(error).toBeNull();
    expect(data).toMatchObject({ changed: true, draft_invoices: 0, job_updated: false });
    // Every row of both companies' quotes, orders, jobs and invoices but this quote and its order is byte-identical: the issued invoice,
    // the finished job, the other quote's order, job and draft invoice, and company beta's quote.
    expect(await fingerprint(q.id, accepted.so_id)).toBe(before);
    expect(await poOf("invoices", invoice)).toBe("4471");
    expect(await poOf("jobs", accepted.job_id)).toBe("4471");
    expect(await poOf("quotes", q.id)).toBe("4472");
    expect(await poOf("sales_orders", accepted.so_id)).toBe("4472");
  });

  it("a sent quote stays frozen: its PO and any other field refused by a direct write (the quote unchanged)", async () => {
    const q = await quote("4471");
    for (const change of [{ customer_po: "9999" }, { description: "changed" }]) {
      const { error } = await as.office.from("quotes").update(change).eq("id", q.id).select("id");
      expect({ change, code: error?.code }).toEqual({ change, code: "42501" });
    }
    expect(await one("select customer_po, description from public.quotes where id = $1", [q.id])).toEqual({ customer_po: "4471", description: null });
  });

  it("revising a sent quote keeps the PO on the new version; the superseded one is refused", async () => {
    const q = await quote("6000");
    const { data, error } = await as.office.rpc("revise_quote", { p_quote: q.id });
    expect(error).toBeNull();
    expect(await poOf("quotes", (data as { quote_id: string }).quote_id)).toBe("6000");
    expect((await as.office.rpc("set_quote_customer_po", { p_quote: q.id, p_customer_po: "X" })).error?.code).toBe("22023");
  });

  it("refused for the workshop, another company's quote, an empty PO once there is an order, and over 100 characters", async () => {
    const mine = await quote(null);
    await accept(mine.id);
    const theirs = await quote("B-PO", "beta");
    expect((await as.workshop.rpc("set_quote_customer_po", { p_quote: mine.id, p_customer_po: "X" })).error?.code).toBe("42501");
    expect((await as.office.rpc("set_quote_customer_po", { p_quote: theirs.id, p_customer_po: "X" })).error?.code).toBe("P0002");
    expect((await as.office.rpc("set_quote_customer_po", { p_quote: mine.id, p_customer_po: "   " })).error?.code).toBe("22023");
    expect((await as.office.rpc("set_quote_customer_po", { p_quote: mine.id, p_customer_po: "x".repeat(101) })).error?.code).toBe("22023");
    expect(await poOf("quotes", theirs.id)).toBe("B-PO");
    expect(await poOf("quotes", mine.id)).toBeNull();
  });
});
