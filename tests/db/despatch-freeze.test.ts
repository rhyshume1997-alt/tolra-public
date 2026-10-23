/**
 * Despatch is checked again when a note goes out, and a note that has gone out is frozen (migration 034, audit). The release is
 * rechecked with the job row locked at the moment the note is marked sent out or signed, not only when it was made; a sent or
 * signed note's details and items can't be edited or deleted, it only moves forward, and a signed note keeps its signature.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, allowInspectors, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let n = 0;
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  await allowInspectors(world);
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** An order with one line of 1, converted to its job (not yet inspected). */
async function orderAndJob() {
  n += 1;
  const service = adminClient();
  const org = world.tenants.alpha.id;
  const { data: order, error } = await service.from("sales_orders").insert({
    organization_id: org, so_number: `SO-FRZ-${world.runId}-${n}`, customer_po: `PO-FRZ-${world.runId}-${n}`, customer: "Freeze Co", total_value: 100, status: "open",
  }).select("id").single();
  if (error) throw new Error(error.message);
  const converted = await as.admin.rpc("convert_sales_order", { p_order: order.id });
  if (converted.error) throw new Error(converted.error.message);
  const job = converted.data.job_id as string;
  await service.from("jobs").update({ started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z" }).eq("id", job);
  return { order: order.id as string, job };
}
const pass = async (job: string) => recordInspection(as.workshop, { p_job: job, p_result: "pass", p_notes: "In tolerance", p_attachment_path: null, p_attachment_name: null, p_concession_reason: null,
  p_expected_version: (await adminClient().from("jobs").select("worksheet_version").eq("id", job).single()).data!.worksheet_version });
async function noteFor(order: string, job: string) {
  const all = (await as.office.rpc("despatch_lines", { p_order: order, p_job: null })).data as Array<{ line_id: string }>;
  const made = await as.office.rpc("create_delivery_note", { p_order: order, p_job: job, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: "Own van", p_notes: null, p_lines: [{ line_id: all[0].line_id, quantity: 1 }] });
  if (made.error) throw new Error(made.error.message);
  return made.data.id as string;
}
/** Refused by the freeze (42501), or not even visible to the delete policy (the workshop): either way nothing is deleted. */
const expectNotDeleted = async (request: PromiseLike<{ error: { code?: string } | null; data: unknown[] | null }>, label: string) => {
  const { error, data } = await request;
  if (error) expect(error.code, label).toBe("42501");
  else expect(data ?? [], label).toHaveLength(0);
};
const status = async (id: string) => (await adminClient().from("delivery_notes").select("status").eq("id", id).single()).data!.status as string;

describe("the release is checked again when the note goes out", () => {
  it("a release withdrawn after the note was made stops it being sent or signed, until the job is inspected again", async () => {
    const { order, job } = await orderAndJob();
    expect((await pass(job)).error).toBeNull();
    const note = await noteFor(order, job);
    // Withdrawn after the note was made (here directly, as the importer or service role could).
    expect((await adminClient().from("jobs").update({ inspected_at: null, inspected_by: null }).eq("id", job)).error).toBeNull();
    for (const role of ["admin", "office", "workshop"]) {
      const sent = await as[role].from("delivery_notes").update({ status: "despatched" }).eq("id", note).select("id");
      expect(sent.error, `${role} sent`).toMatchObject({ code: "22023" });
      expect(sent.error!.message).toMatch(/can't be sent out/);
      expect((await as[role].from("delivery_notes").update({ status: "signed", signed_by_name: "X", signed_at: new Date().toISOString() }).eq("id", note).select("id")).error, `${role} signed`).toMatchObject({ code: "22023" });
    }
    expect(await status(note)).toBe("awaiting");
    expect((await pass(job)).error).toBeNull();
    expect((await as.office.from("delivery_notes").update({ status: "despatched" }).eq("id", note).select("id")).data).toHaveLength(1);
  });

  it("holds a note made by hand for a job number too, but not one with no job, and the service role is not held", async () => {
    const { job } = await orderAndJob();
    const { data: row } = await adminClient().from("jobs").select("job_no").eq("id", job).single();
    const create = (jobRef: string | null) => as.office.rpc("create_with_lines", {
      p_parent: "delivery_notes", p_header: { dn_number: `DLN-FRZ-${world.runId}-${n += 1}`, customer: "Freeze Co", job_ref: jobRef, delivery_date: TODAY, ship_date: TODAY, tax_date: TODAY, status: "awaiting" },
      p_child: "delivery_note_items", p_fk: "delivery_note_id", p_lines: [{ position: 0, description: "Hand item", quantity: 1 }],
    });
    const make = async (jobRef: string | null) => (await create(jobRef)).data as string;
    // 081 (8.6): a note naming a job that isn't Complete isn't even made; one made while it was, is held when it goes out after a withdrawal.
    expect((await create(row!.job_no)).error).toMatchObject({ code: "22023", hint: "job_not_released" });
    expect((await pass(job)).error).toBeNull();
    const held = await make(row!.job_no);
    expect((await adminClient().from("jobs").update({ inspected_at: null, inspected_by: null }).eq("id", job)).error).toBeNull();
    expect((await as.office.from("delivery_notes").update({ status: "despatched" }).eq("id", held).select("id")).error).toMatchObject({ code: "22023" });
    const free = await make(null);
    expect((await as.office.from("delivery_notes").update({ status: "despatched" }).eq("id", free).select("id")).data).toHaveLength(1);
    expect((await adminClient().from("delivery_notes").update({ status: "despatched" }).eq("id", held)).error).toBeNull();
  });

  it("creating a note locks the job row, and marking it sent does too, so a withdrawal can't slip in between", async () => {
    // 037 takes the job row FOR UPDATE (as a failure does) and reads the release per batch under it; the concurrent case is in
    // tests/db/rework.test.ts.
    await withDb(async (db) => {
      const src = (await db.query("select prosrc from pg_proc where proname = 'create_delivery_note' and pronamespace = 'public'::regnamespace")).rows[0].prosrc as string;
      expect((src.match(/FROM public\.jobs WHERE id = v_job_id AND organization_id = v_org FOR UPDATE/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(src).toMatch(/job_release_state/);
      const guard = (await db.query("select prosrc from pg_proc where proname = 'delivery_notes_link_guard' and pronamespace = 'public'::regnamespace")).rows[0].prosrc as string;
      expect(guard).toMatch(/FOR UPDATE/);
      expect(guard).toMatch(/job_release_state/);
    });
  });
});

describe("a note that has gone out is frozen", () => {
  it("its details and items can't be edited or deleted; it only moves forward; only the signature and e-mail record are written", async () => {
    const { order, job } = await orderAndJob();
    expect((await pass(job)).error).toBeNull();
    const note = await noteFor(order, job);
    const item = (await adminClient().from("delivery_note_items").select("id").eq("delivery_note_id", note)).data![0].id as string;
    // Awaiting: ordinary edits still work.
    expect((await as.office.from("delivery_notes").update({ ship_via: "Courier" }).eq("id", note).select("id")).data).toHaveLength(1);
    expect((await as.office.from("delivery_notes").update({ status: "despatched" }).eq("id", note).select("id")).data).toHaveLength(1);

    for (const role of ["admin", "office", "workshop"]) {
      const label = (what: string) => `${role} ${what}`;
      for (const change of [{ ship_via: "Other" }, { customer: "Else Ltd" }, { notes: "late edit" }, { delivery_date: "2020-01-01" }, { job_ref: "J-0" }, { tax_date: "2020-01-01" }, { customer_email: "x@example.com" }]) {
        expect((await as[role].from("delivery_notes").update(change).eq("id", note).select("id")).error, label(JSON.stringify(change))).toMatchObject({ code: "42501" });
      }
      expect((await as[role].from("delivery_notes").update({ status: "awaiting" }).eq("id", note).select("id")).error, label("back")).toMatchObject({ code: "42501" });
      await expectNotDeleted(as[role].from("delivery_notes").delete().eq("id", note).select("id"), label("delete"));
      expect((await as[role].from("delivery_note_items").update({ description: "Changed" }).eq("id", item).select("id")).error, label("item edit")).toMatchObject({ code: "42501" });
      await expectNotDeleted(as[role].from("delivery_note_items").delete().eq("id", item).select("id"), label("item delete"));
      expect((await as[role].from("delivery_note_items").insert({ organization_id: world.tenants.alpha.id, delivery_note_id: note, position: 5, description: "Extra", quantity: 1 })).error, label("item add")).toMatchObject({ code: "42501" });
    }
    expect((await adminClient().from("delivery_note_items").select("description, quantity").eq("delivery_note_id", note)).data).toHaveLength(1);
    expect((await adminClient().from("delivery_notes").select("ship_via, customer").eq("id", note).single()).data).toMatchObject({ ship_via: "Courier", customer: "Freeze Co" });

    // The e-mail record and the signature can still be written; the signature once.
    expect((await as.office.from("delivery_notes").update({ emailed_at: new Date().toISOString() }).eq("id", note).select("id")).data).toHaveLength(1);
    const signedAt = "2026-10-10T12:00:00.000Z";
    expect((await as.workshop.from("delivery_notes").update({ status: "signed", signed_by_name: "A. Driver", signed_at: signedAt, signature_notes: "Counted in" }).eq("id", note).select("id")).data).toHaveLength(1);
    for (const role of ["admin", "office", "workshop"]) {
      expect((await as[role].from("delivery_notes").update({ signed_by_name: "Someone else" }).eq("id", note).select("id")).error, `${role} re-sign`).toMatchObject({ code: "42501" });
      expect((await as[role].from("delivery_notes").update({ status: "delivered" }).eq("id", note).select("id")).error, `${role} un-sign`).toMatchObject({ code: "42501" });
      await expectNotDeleted(as[role].from("delivery_notes").delete().eq("id", note).select("id"), `${role} delete signed`);
    }
    expect((await as.office.from("delivery_notes").update({ emailed_at: new Date().toISOString() }).eq("id", note).select("id")).data).toHaveLength(1);
    expect((await adminClient().from("delivery_notes").select("status, signed_by_name, signature_notes").eq("id", note).single()).data).toEqual({ status: "signed", signed_by_name: "A. Driver", signature_notes: "Counted in" });
    // Sent out by a person, it is on its automatic draft (059). With that draft deleted, a signed note can still be invoiced (the function
    // links it), and stays frozen after.
    const drafted = (await adminClient().from("delivery_notes").select("invoice_id").eq("id", note).single()).data!.invoice_id as string;
    expect((await adminClient().from("invoices").select("status").eq("id", drafted).single()).data).toEqual({ status: "draft" });
    expect((await as.office.rpc("create_invoice_from_delivery_notes", { p_notes: [note], p_invoice_date: TODAY, p_due_date: TODAY, p_terms: "30 days" })).error).toMatchObject({ code: "22023" });
    expect((await as.office.from("invoices").delete().eq("id", drafted).select("id")).data).toHaveLength(1);
    expect((await as.office.rpc("create_invoice_from_delivery_notes", { p_notes: [note], p_invoice_date: TODAY, p_due_date: TODAY, p_terms: "30 days" })).error).toBeNull();
  });

  it("a hand-made note is frozen the same way once sent out, and the viewer can't touch any", async () => {
    n += 1;
    const id = (await as.workshop.rpc("create_with_lines", {
      p_parent: "delivery_notes", p_header: { dn_number: `DLN-FRZH-${world.runId}-${n}`, customer: "Freeze Co", delivery_date: TODAY, ship_date: TODAY, tax_date: TODAY, status: "awaiting" },
      p_child: "delivery_note_items", p_fk: "delivery_note_id", p_lines: [{ position: 0, description: "Hand item", quantity: 2 }],
    })).data as string;
    expect((await as.workshop.from("delivery_notes").update({ status: "despatched" }).eq("id", id).select("id")).data).toHaveLength(1);
    expect((await as.workshop.from("delivery_notes").update({ customer: "Else" }).eq("id", id).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.office.from("delivery_note_items").update({ quantity: 9 }).eq("delivery_note_id", id).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.viewer.from("delivery_notes").update({ status: "signed" }).eq("id", id).select("id")).data ?? []).toHaveLength(0);
    expect(await status(id)).toBe("despatched");
  });
});
