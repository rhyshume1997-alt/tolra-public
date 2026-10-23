/**
 * Quote versions, partial acceptance and one row per part (migration 068). revise_quote makes the next version of a sent quote as a
 * draft ("QUO-n v2") and supersedes the one it replaces; only the latest version is decided. accept_quote's p_lines records which lines
 * the customer's PO covers; the sales order, its lines, the job and the despatch carry those only. Part / drawing / revision travel
 * from the quote line to the order line and the job's worksheet. Two people at once never make two versions or two orders.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const as = {} as Record<"admin" | "office" | "workshop" | "viewer", SupabaseClient>;
let beta: SupabaseClient;
let seq = 0;
const org = () => world.tenants.alpha.id;

type Line = { quantity: number; unit_price: number; vat_pct?: number; description?: string; part_number?: string; drawing_number?: string; drawing_revision?: string };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  beta = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A quote made as the app makes it (create_with_lines, office), sent unless told otherwise. A QUO number so jobs take J-n. */
async function quote(lines: Line[], opts: { send?: boolean } = {}) {
  seq += 1;
  // A fresh company each run, so plain numbers are free.
  const ref = `QUO-${8100 + seq}`;
  const total = documentTotals(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, vatPct: l.vat_pct ?? 20 })), 0, { vatEnabled: true }).total;
  const { data: id, error } = await as.office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer: `Versions Co ${seq}`, total_value: total, vat_enabled: true, status: opts.send === false ? "draft" : "sent", valid_until: "2099-12-31" },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: lines.map((l, position) => ({ position, description: l.description ?? `Line ${position}`, quantity: l.quantity, unit_price: l.unit_price, vat_pct: l.vat_pct ?? 20, vat_exempt: false,
      ...(l.part_number ? { part_number: l.part_number } : {}), ...(l.drawing_number ? { drawing_number: l.drawing_number } : {}), ...(l.drawing_revision ? { drawing_revision: l.drawing_revision } : {}) })),
  });
  if (error) throw new Error(error.message);
  const ids = ((await adminClient().from("quote_line_items").select("id").eq("quote_id", id).order("position")).data ?? []).map((r) => r.id as string);
  return { id: id as string, ref, lines: ids, total };
}
const quoteRow = async (id: string) => (await adminClient().from("quotes").select("*").eq("id", id).single()).data!;
const revise = (client: SupabaseClient, id: string) => client.rpc("revise_quote", { p_quote: id });
const accept = (client: SupabaseClient, id: string, lines?: string[] | null) =>
  client.rpc("accept_quote", { p_quote: id, p_customer_po: null, p_delivery_date: null, ...(lines === undefined ? {} : { p_lines: lines }) });
const ok = async (client: SupabaseClient, id: string, lines?: string[] | null) => {
  const { data, error } = await accept(client, id, lines);
  if (error) throw new Error(`accept_quote: ${error.message}`);
  return data;
};
const ordersFor = async (quoteId: string) => (await adminClient().from("sales_orders").select("*").eq("quote_id", quoteId)).data ?? [];
const events = (action: string, id: string) =>
  withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where action = $1 and entity_table = 'quotes' and entity_id = $2", [action, id])).rows);

describe("revising a sent quote", () => {
  it("makes the next version as a draft with the same number + ' v2', the lines and parts copied; the old one is superseded", async () => {
    const q = await quote([{ quantity: 2, unit_price: 50, part_number: "P-100", drawing_number: "D-200", drawing_revision: "B" }, { quantity: 1, unit_price: 30 }]);
    const { data, error } = await revise(as.office, q.id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ quote_ref: `${q.ref} v2`, version: 2, previous_quote_id: q.id });
    const v2 = await quoteRow(data.quote_id);
    expect(v2).toMatchObject({ quote_ref: `${q.ref} v2`, version: 2, previous_version_id: q.id, status: "draft", organization_id: org() });
    expect(Number(v2.total_value)).toBe(q.total);
    expect((await quoteRow(q.id)).status).toBe("superseded");
    const lines = (await adminClient().from("quote_line_items").select("quantity, unit_price, part_number, drawing_number, drawing_revision, declined").eq("quote_id", v2.id).order("position")).data!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ part_number: "P-100", drawing_number: "D-200", drawing_revision: "B", declined: false });
    expect(await events("REVISE", v2.id)).toHaveLength(1);
  });

  it("only the latest version is decided: the superseded one can't be accepted, rejected, re-sent or revised again", async () => {
    const q = await quote([{ quantity: 1, unit_price: 40 }]);
    await revise(as.office, q.id);
    expect((await accept(as.office, q.id)).error?.hint).toBe("quote_superseded");
    expect((await as.office.from("quotes").update({ status: "rejected", rejected_at: new Date().toISOString() }).eq("id", q.id)).error?.code).toBe("42501");
    expect((await as.office.from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", q.id)).error?.code).toBe("42501");
    expect((await as.office.from("quotes").update({ sent_at: new Date().toISOString() }).eq("id", q.id)).error?.code).toBe("42501");
    expect((await revise(as.admin, q.id)).error?.message).toMatch(/already been revised/);
    expect((await quoteRow(q.id)).status).toBe("superseded");
    expect(await ordersFor(q.id)).toHaveLength(0);
  });

  it("a draft or a decided quote isn't revised; viewer, workshop and another company are refused; a version can't be forged", async () => {
    const draft = await quote([{ quantity: 1, unit_price: 10 }], { send: false });
    expect((await revise(as.office, draft.id)).error?.message).toMatch(/only a sent quote/);
    const q = await quote([{ quantity: 1, unit_price: 10 }]);
    for (const role of ["viewer", "workshop"] as const) expect({ role, code: (await revise(as[role], q.id)).error?.code }).toEqual({ role, code: "42501" });
    expect((await revise(beta, q.id)).error?.code).toBe("P0002");
    expect((await quoteRow(q.id)).status).toBe("sent");
    // A revision can't be inserted or re-pointed by hand.
    const forged = await as.office.from("quotes").insert({ organization_id: org(), quote_ref: `${q.ref} v9`, customer: "X", status: "draft", version: 2, previous_version_id: q.id });
    expect(forged.error?.code).toBe("42501");
    await ok(as.office, q.id);
    expect((await revise(as.office, q.id)).error?.message).toMatch(/only a sent quote/);
  });

  it("deleting the draft revision makes the version it replaced the latest again", async () => {
    const q = await quote([{ quantity: 1, unit_price: 25 }]);
    const { data } = await revise(as.office, q.id);
    expect((await as.office.from("quotes").delete().eq("id", data.quote_id)).error).toBeNull();
    expect((await quoteRow(q.id)).status).toBe("sent");
    const again = await revise(as.admin, q.id);
    expect(again.data).toMatchObject({ quote_ref: `${q.ref} v2`, version: 2 });
  });

  it("v3 accepted: its job takes the quote's own number and keeps the versioned reference; part details reach the worksheet", async () => {
    const q = await quote([{ quantity: 5, unit_price: 20, description: "Pin", drawing_number: "DP-7", drawing_revision: "D" }]);
    const v2 = (await revise(as.office, q.id)).data;
    expect((await as.office.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", v2.quote_id)).error).toBeNull();
    const v3 = (await revise(as.office, v2.quote_id)).data;
    expect(v3).toMatchObject({ quote_ref: `${q.ref} v3`, version: 3 });
    expect((await as.office.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", v3.quote_id)).error).toBeNull();
    const result = await ok(as.office, v3.quote_id);
    expect(result).toMatchObject({ accepted: true, so_created: true, job_created: true, version: 3 });
    const job = (await adminClient().from("jobs").select("job_no, quote_ref, drawing_no, quantity_required, specification").eq("id", result.job_id).single()).data!;
    expect(job).toMatchObject({ job_no: `J-${q.ref.slice(4)}`, quote_ref: `${q.ref} v3`, drawing_no: "DP-7 rev D", quantity_required: 5 });
    expect(job.specification).toContain("- Pin [Dwg DP-7 rev D] x 5");
  });

  it("Convert to Job by hand on a v2 order works for office, and a customer PO filed later under the quote's number reaches that job", async () => {
    const q = await quote([{ quantity: 3, unit_price: 9, description: "Hand", part_number: "H-1", drawing_number: "DH-1", drawing_revision: "A" }]);
    const v2 = (await revise(as.office, q.id)).data;
    expect((await as.office.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", v2.quote_id)).error).toBeNull();
    await withDb((db) => db.query("insert into public.organization_settings (organization_id, auto_convert_sales_orders) values ($1, false) on conflict (organization_id) do update set auto_convert_sales_orders = false", [org()]));
    try {
      const result = await ok(as.office, v2.quote_id);
      expect(result).toMatchObject({ so_created: true, job_id: null });
      // convert_sales_order is INVOKER: the 068 text helpers it calls run as office.
      const { data: converted, error } = await as.office.rpc("convert_sales_order", { p_order: result.so_id });
      expect(error).toBeNull();
      const job = (await adminClient().from("jobs").select("job_no, quote_ref, drawing_no, specification").eq("id", converted.job_id).single()).data!;
      expect(job).toMatchObject({ job_no: `J-${q.ref.slice(4)}`, quote_ref: `${q.ref} v2`, drawing_no: "DH-1 rev A" });
      expect(job.specification).toContain("- Hand [Part H-1; Dwg DH-1 rev A] x 3");
      // 067's customer PO, uploaded under the quote's own number (where every version files its attachments), reaches the v2 job.
      const path = `${org()}/${q.ref}/customer-po-${seq}.pdf`;
      expect((await as.office.from("quote_attachments").insert({ organization_id: org(), quote_ref: q.ref, file_path: path, file_name: "customer-po.pdf", kind: "customer_po" })).error).toBeNull();
      const refs = (await adminClient().from("job_files").select("kind, storage_path").eq("job_id", converted.job_id).eq("kind", "customer_po")).data;
      expect(refs).toEqual([{ kind: "customer_po", storage_path: path }]);
    } finally {
      await withDb((db) => db.query("update public.organization_settings set auto_convert_sales_orders = true where organization_id = $1", [org()]));
    }
  });

  it("two people revising at once make one version; revise and accept at once: one wins, nothing doubled", async () => {
    for (let round = 0; round < 3; round += 1) {
      const q = await quote([{ quantity: 1, unit_price: 15 }]);
      const results = await Promise.all([revise(as.admin, q.id), revise(as.office, q.id)]);
      expect(results.filter((r) => r.error === null)).toHaveLength(1);
      expect((await adminClient().from("quotes").select("id").eq("previous_version_id", q.id)).data).toHaveLength(1);

      const t = await quote([{ quantity: 1, unit_price: 15 }]);
      const [r1, r2] = await Promise.all([revise(as.admin, t.id), accept(as.office, t.id)]);
      expect([r1.error === null, r2.error === null].filter(Boolean)).toHaveLength(1);
      const status = (await quoteRow(t.id)).status;
      const revisions = (await adminClient().from("quotes").select("id").eq("previous_version_id", t.id)).data!.length;
      const orders = (await ordersFor(t.id)).length;
      expect(status === "accepted" ? { revisions, orders } : { status, revisions, orders }).toEqual(status === "accepted" ? { revisions: 0, orders: 1 } : { status: "superseded", revisions: 1, orders: 0 });
    }
  });
});

describe("accepting only the lines the customer's PO covers", () => {
  it("the order, its lines, the job and the despatch carry the ticked lines only, with their parts", async () => {
    const q = await quote([
      { quantity: 4, unit_price: 25, description: "Shaft", part_number: "S-1", drawing_number: "DS-1", drawing_revision: "A" },
      { quantity: 10, unit_price: 3.5, description: "Collar" },
      { quantity: 1, unit_price: 80, description: "Plate", part_number: "PL-9" },
    ]);
    const result = await ok(as.office, q.id, [q.lines[0], q.lines[2]]);
    expect(result).toMatchObject({ accepted: true, so_created: true, job_created: true, lines_ordered: 2, lines_declined: 1 });
    const [order] = await ordersFor(q.id);
    expect(Number(order.total_value)).toBe(180);
    const declined = (await adminClient().from("quote_line_items").select("declined").eq("quote_id", q.id).order("position")).data!.map((r) => r.declined);
    expect(declined).toEqual([false, true, false]);
    const job = (await adminClient().from("jobs").select("specification").eq("id", result.job_id).single()).data!;
    expect(job.specification).toContain("- Shaft [Part S-1; Dwg DS-1 rev A] x 4");
    expect(job.specification).toContain("- Plate [Part PL-9] x 1");
    expect(job.specification).not.toContain("Collar");
    expect((await as.office.rpc("ensure_sales_order_lines", { p_order: order.id })).error).toBeNull();
    const lines = (await adminClient().from("sales_order_lines").select("description, part_number, drawing_number, drawing_revision, source_quote_line_id").eq("sales_order_id", order.id).order("position")).data!;
    expect(lines).toEqual([
      { description: "Shaft", part_number: "S-1", drawing_number: "DS-1", drawing_revision: "A", source_quote_line_id: q.lines[0] },
      { description: "Plate", part_number: "PL-9", drawing_number: null, drawing_revision: null, source_quote_line_id: q.lines[2] },
    ]);
    expect((await as.workshop.rpc("despatch_lines", { p_order: order.id, p_job: null })).data).toHaveLength(2);
    expect((await events("ACCEPT", q.id))[0].metadata).toMatchObject({ lines_ordered: 2, declined_lines: [q.lines[1]] });
  });

  it("with no line list (as before 068) every line is ordered", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10 }, { quantity: 2, unit_price: 10 }]);
    const result = await ok(as.office, q.id);
    expect(result).toMatchObject({ lines_ordered: 2, lines_declined: 0 });
    expect(Number((await ordersFor(q.id))[0].total_value)).toBe(30);
  });

  it("declining the line at another VAT rate lets one order hold the rest", async () => {
    const q = await quote([{ quantity: 1, unit_price: 100, vat_pct: 20 }, { quantity: 1, unit_price: 50, vat_pct: 5 }]);
    const result = await ok(as.office, q.id, [q.lines[0]]);
    expect(result).toMatchObject({ so_created: true, needs: null });
    expect(Number((await ordersFor(q.id))[0].total_value)).toBe(100);
  });

  it("refused, changing nothing: no line, another quote's line; and the flag is the accept step's alone", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10 }, { quantity: 1, unit_price: 20 }]);
    const other = await quote([{ quantity: 1, unit_price: 10 }]);
    expect((await accept(as.office, q.id, [])).error?.message).toMatch(/at least one line/);
    expect((await accept(as.office, q.id, [other.lines[0]])).error?.message).toMatch(/isn't on/);
    expect((await quoteRow(q.id)).status).toBe("sent");
    expect((await as.office.from("quote_line_items").update({ declined: true }).eq("id", q.lines[1])).error?.code).toBe("42501");
    await ok(as.office, q.id, [q.lines[0]]);
    expect((await as.office.from("quote_line_items").update({ declined: false }).eq("id", q.lines[1])).error?.code).toBe("42501");
    expect((await as.office.from("quote_line_items").update({ unit_price: 1 }).eq("id", q.lines[0])).error?.code).toBe("42501");
    // Accepted again with another choice: nothing changes, the same order comes back.
    const again = await ok(as.admin, q.id, [q.lines[1]]);
    expect(again).toMatchObject({ accepted: false, lines_ordered: 1 });
    expect(await ordersFor(q.id)).toHaveLength(1);
    expect(await events("ACCEPT", q.id)).toHaveLength(1);
  });

  it("two people accepting different lines at once: one order, one job, one choice recorded", async () => {
    for (let round = 0; round < 3; round += 1) {
      const q = await quote([{ quantity: 1, unit_price: 10 }, { quantity: 1, unit_price: 20 }, { quantity: 1, unit_price: 30 }]);
      const results = await Promise.all([accept(as.admin, q.id, [q.lines[0]]), accept(as.office, q.id, [q.lines[1], q.lines[2]])]);
      expect(results.map((r) => r.error)).toEqual([null, null]);
      const winner = results.find((r) => r.data.accepted)!.data;
      expect(results.filter((r) => r.data.accepted)).toHaveLength(1);
      const orders = await ordersFor(q.id);
      expect(orders).toHaveLength(1);
      expect(Number(orders[0].total_value)).toBe(winner.lines_ordered === 1 ? 10 : 50);
      expect(await events("ACCEPT", q.id)).toHaveLength(1);
    }
  });
});

describe("one row per part on quote lines", () => {
  it("a draft's correction keeps each line's part, drawing and revision (blank = none)", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10 }], { send: false });
    const { updated_at } = await quoteRow(q.id);
    const { error } = await as.office.rpc("replace_draft_quote", {
      p_quote: q.id, p_expected_updated_at: updated_at, p_header: { total_value: 36 },
      p_lines: [{ description: "A", quantity: 1, unit_price: 10, vat_pct: 20, part_number: "P-1", drawing_number: "D-1", drawing_revision: "C" },
                { description: "B", quantity: 1, unit_price: 20, vat_pct: 20, part_number: "  ", drawing_revision: "" }],
    });
    expect(error).toBeNull();
    const lines = (await adminClient().from("quote_line_items").select("part_number, drawing_number, drawing_revision").eq("quote_id", q.id).order("position")).data;
    expect(lines).toEqual([{ part_number: "P-1", drawing_number: "D-1", drawing_revision: "C" }, { part_number: null, drawing_number: null, drawing_revision: null }]);
  });

  it("create_with_lines stores a blank part field as none and trims the rest (quote_line_part_clean), never failing the check", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10, part_number: "   ", drawing_number: " D-9 ", drawing_revision: " " }], { send: false });
    const line = (await adminClient().from("quote_line_items").select("part_number, drawing_number, drawing_revision").eq("quote_id", q.id).single()).data;
    expect(line).toEqual({ part_number: null, drawing_number: "D-9", drawing_revision: null });
  });
});
