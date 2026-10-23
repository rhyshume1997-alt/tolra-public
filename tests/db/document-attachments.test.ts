/**
 * Migration 067. Files on delivery notes and purchase orders (document_attachments and the document-attachments bucket): same company
 * only, roles as for the parent (delivery note: admin, office, workshop; purchase order: admin and office), a sent-out note keeps its
 * files, a stored file is never overwritten and is deleted only after its row. The customer's PO uploaded to a quote is listed on the
 * job as 'customer_po' (at conversion and when uploaded later) and the workshop can open it. A draft invoice is corrected in one step
 * (replace_draft_invoice); issued invoices stay locked. A delivery note put on its job's draft invoice (link_delivery_note_to_invoice)
 * makes no second draft when it goes out (059).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, allowInspectors, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const as = {} as Record<"admin" | "office" | "workshop" | "viewer", SupabaseClient>;
let betaAdmin: SupabaseClient;
let seq = 0;
const org = (tenant: "alpha" | "beta" = "alpha") => world.tenants[tenant].id;
const BUCKET = "document-attachments";
const PDF = Buffer.from("%PDF-1.4\n%synthetic\n");
const PDF_OPTIONS = { contentType: "application/pdf" };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  await allowInspectors(world);
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) {
    const service = adminClient();
    for (const tenant of ["alpha", "beta"] as const) {
      for (const folder of ["delivery-notes", "purchase-orders"]) {
        const parents = (await service.storage.from(BUCKET).list(`${org(tenant)}/${folder}`, { limit: 200 })).data ?? [];
        for (const parent of parents) {
          const files = (await service.storage.from(BUCKET).list(`${org(tenant)}/${folder}/${parent.name}`, { limit: 200 })).data ?? [];
          if (files.length) await service.storage.from(BUCKET).remove(files.map((f) => `${org(tenant)}/${folder}/${parent.name}/${f.name}`));
        }
      }
    }
    await destroySyntheticWorld(world.runId);
  }
});

async function note(tenant: "alpha" | "beta" = "alpha", extra: Record<string, unknown> = {}) {
  seq += 1;
  const { data, error } = await adminClient().from("delivery_notes").insert({ organization_id: org(tenant), dn_number: `DN-067-${world.runId}-${seq}`, customer: "Attach Co", status: "pending", ...extra }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
async function purchaseOrder(tenant: "alpha" | "beta" = "alpha") {
  const { data, error } = await adminClient().from("purchase_orders").insert({ organization_id: org(tenant), status: "draft" }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const path = (tenant: "alpha" | "beta", folder: "delivery-notes" | "purchase-orders", parent: string, name: string) => `${org(tenant)}/${folder}/${parent}/${name}`;
async function attach(client: SupabaseClient, parent: { delivery_note_id?: string; purchase_order_id?: string }, name = "file.pdf", tenant: "alpha" | "beta" = "alpha") {
  const folder = parent.delivery_note_id ? "delivery-notes" : "purchase-orders";
  const storagePath = path(tenant, folder, (parent.delivery_note_id ?? parent.purchase_order_id)!, `${Date.now()}-${seq}-${name}`);
  const upload = await client.storage.from(BUCKET).upload(storagePath, PDF, PDF_OPTIONS);
  if (upload.error) return { error: upload.error, storagePath };
  const { data: user } = await client.auth.getUser();
  const row = await client.from("document_attachments").insert({ organization_id: org(tenant), ...parent, file_name: name, storage_path: storagePath, mime_type: "application/pdf", size_bytes: PDF.length, uploaded_by: user.user?.id }).select("id").single();
  return { error: row.error, storagePath, id: row.data?.id as string | undefined };
}

describe("files on delivery notes and purchase orders", () => {
  it("delivery note: admin, office and workshop attach and read; the viewer neither", async () => {
    const dn = await note();
    for (const role of ["admin", "office", "workshop"] as const) expect({ role, error: (await attach(as[role], { delivery_note_id: dn }, `${role}.pdf`)).error }).toEqual({ role, error: null });
    expect((await attach(as.viewer, { delivery_note_id: dn })).error).not.toBeNull();
    expect((await as.workshop.from("document_attachments").select("id").eq("delivery_note_id", dn)).data).toHaveLength(3);
    expect((await as.viewer.from("document_attachments").select("id").eq("delivery_note_id", dn)).data).toHaveLength(0);
    const [first] = (await as.office.from("document_attachments").select("storage_path").eq("delivery_note_id", dn)).data ?? [];
    expect((await as.workshop.storage.from(BUCKET).download(first.storage_path)).error).toBeNull();
    expect((await as.viewer.storage.from(BUCKET).download(first.storage_path)).error).not.toBeNull();
  });

  it("purchase order: admin and office only", async () => {
    const po = await purchaseOrder();
    expect((await attach(as.office, { purchase_order_id: po })).error).toBeNull();
    expect((await attach(as.workshop, { purchase_order_id: po })).error).not.toBeNull();
    expect((await as.workshop.from("document_attachments").select("id").eq("purchase_order_id", po)).data).toHaveLength(0);
  });

  it("another company: nothing seen, nothing attached, nothing uploaded into its folders", async () => {
    const dn = await note();
    const own = await attach(as.office, { delivery_note_id: dn });
    expect(own.error).toBeNull();
    expect((await betaAdmin.from("document_attachments").select("id").eq("delivery_note_id", dn)).data).toHaveLength(0);
    expect((await betaAdmin.storage.from(BUCKET).download(own.storagePath)).error).not.toBeNull();
    // Beta writing into alpha's folder, and alpha pointing a row at beta's note.
    expect((await betaAdmin.storage.from(BUCKET).upload(path("alpha", "delivery-notes", dn, "x.pdf"), PDF, PDF_OPTIONS)).error).not.toBeNull();
    const betaNote = await note("beta");
    expect((await as.admin.storage.from(BUCKET).upload(path("alpha", "delivery-notes", betaNote, "x.pdf"), PDF, PDF_OPTIONS)).error).not.toBeNull();
    const { data: user } = await as.admin.auth.getUser();
    const crossRow = await as.admin.from("document_attachments").insert({ organization_id: org(), delivery_note_id: betaNote, file_name: "x.pdf", storage_path: path("alpha", "delivery-notes", betaNote, "x.pdf"), uploaded_by: user.user?.id });
    expect(crossRow.error).not.toBeNull();
  });

  it("a stored file is not overwritten, and is deleted only after its row", async () => {
    const dn = await note();
    const added = await attach(as.workshop, { delivery_note_id: dn });
    expect(added.error).toBeNull();
    expect((await as.workshop.storage.from(BUCKET).upload(added.storagePath, PDF, { ...PDF_OPTIONS, upsert: true })).error).not.toBeNull();
    expect((await as.workshop.storage.from(BUCKET).remove([added.storagePath])).data ?? []).toHaveLength(0);
    expect((await as.workshop.from("document_attachments").update({ file_name: "renamed.pdf" }).eq("id", added.id!)).error).not.toBeNull();
    expect((await as.workshop.from("document_attachments").delete().eq("id", added.id!).select("id")).data).toHaveLength(1);
    expect((await as.workshop.storage.from(BUCKET).remove([added.storagePath])).data ?? []).toHaveLength(1);
  });

  it("a sent-out delivery note keeps its files: more can be added, none removed", async () => {
    const dn = await note("alpha", { status: "despatched" });
    const added = await attach(as.office, { delivery_note_id: dn });
    expect(added.error).toBeNull();
    const removed = await as.office.from("document_attachments").delete().eq("id", added.id!).select("id");
    expect(removed.error?.message).toMatch(/has been sent out/);
  });
});

describe("the customer's PO on the quote travels to the job", () => {
  it("uploaded before acceptance: the job made from the quote lists it as the customer PO, and the workshop can open it", async () => {
    seq += 1;
    const service = adminClient();
    await withDb((db) => db.query("insert into public.organization_settings (organization_id, auto_convert_sales_orders) values ($1, true) on conflict (organization_id) do update set auto_convert_sales_orders = true", [org()]));
    const ref = `QPO-${world.runId}-${seq}`;
    // Made as a draft, given its line, then sent: a sent quote's lines are locked for every API role, service_role included (020).
    const { data: quote, error: quoteError } = await service.from("quotes").insert({ organization_id: org(), quote_ref: ref, customer: "PO Co", status: "draft", total_value: 100, vat_enabled: false }).select("id").single();
    expect(quoteError).toBeNull();
    expect((await service.from("quote_line_items").insert({ organization_id: org(), quote_id: quote!.id, position: 0, description: "Part", quantity: 1, unit_price: 100, vat_pct: 20 })).error).toBeNull();
    expect((await service.from("quotes").update({ status: "sent" }).eq("id", quote!.id)).error).toBeNull();
    const poPath = `${org()}/${ref}/po.pdf`;
    expect((await as.office.storage.from("quote-attachments").upload(poPath, PDF, PDF_OPTIONS)).error).toBeNull();
    expect((await as.office.from("quote_attachments").insert({ organization_id: org(), quote_ref: ref, file_path: poPath, file_name: "PO 4471.pdf", kind: "customer_po" })).error).toBeNull();
    const accepted = await as.office.rpc("accept_quote", { p_quote: quote!.id, p_customer_po: "4471", p_delivery_date: null });
    expect(accepted.error).toBeNull();
    expect(accepted.data).toMatchObject({ so_created: true, job_created: true, needs: null, job_reason: null });
    const jobId = (accepted.data as { job_id: string }).job_id;
    const { data: files, error: filesError } = await as.workshop.from("job_files").select("kind, ref, storage_bucket, storage_path").eq("job_id", jobId);
    expect(filesError).toBeNull();
    expect(files).toEqual([{ kind: "customer_po", ref: "Customer PO", storage_bucket: "quote-attachments", storage_path: poPath }]);
    expect((await as.workshop.storage.from("quote-attachments").download(poPath)).error).toBeNull();
    // What a quote file is never changes.
    expect((await as.office.from("quote_attachments").update({ kind: "file" }).eq("file_path", poPath)).error).not.toBeNull();
  });

  it("uploaded after the job exists: referenced on the job; the workshop can't make such a reference itself", async () => {
    seq += 1;
    const ref = `QPO-${world.runId}-${seq}`;
    const { data: job } = await adminClient().from("jobs").insert({ organization_id: org(), job_no: `J-PO-${seq}-${world.runId}`, customer: "PO Co", quote_ref: ref }).select("id").single();
    const poPath = `${org()}/${ref}/po.pdf`;
    await as.office.storage.from("quote-attachments").upload(poPath, PDF, PDF_OPTIONS);
    const { data: attachment } = await as.office.from("quote_attachments").insert({ organization_id: org(), quote_ref: ref, file_path: poPath, file_name: "po.pdf", kind: "customer_po" }).select("id").single();
    expect((await as.workshop.from("job_files").select("kind").eq("job_id", job!.id)).data).toEqual([{ kind: "customer_po" }]);
    const { data: other } = await adminClient().from("jobs").insert({ organization_id: org(), job_no: `J-PO2-${seq}-${world.runId}`, customer: "PO Co" }).select("id").single();
    const forged = await as.workshop.from("job_files").insert({ organization_id: org(), job_id: other!.id, kind: "drawing", ref: "PO", file_name: "po.pdf", storage_bucket: "quote-attachments", storage_path: poPath, source_attachment_id: attachment!.id });
    expect(forged.error).not.toBeNull();
  });

  // 067 review, finding 1: the check reads the quote file whatever sections the person has hidden (a role-only definer helper).
  it("office with the quotes section hidden: the conversion copy of the PO is still accepted (convert_sales_order is INVOKER)", async () => {
    seq += 1;
    const ref = `QPO-${world.runId}-${seq}`;
    const poPath = `${org()}/${ref}/po.pdf`;
    expect((await as.office.storage.from("quote-attachments").upload(poPath, PDF, PDF_OPTIONS)).error).toBeNull();
    const { data: attachment } = await as.office.from("quote_attachments").insert({ organization_id: org(), quote_ref: ref, file_path: poPath, file_name: "po.pdf", kind: "customer_po" }).select("id").single();
    const { data: job } = await adminClient().from("jobs").insert({ organization_id: org(), job_no: `J-HID-${seq}-${world.runId}`, customer: "PO Co" }).select("id").single();
    const officeId = world.tenants.alpha.users.office.id;
    const hide = (sections: string[]) => withDb((db) => db.query("update public.organization_members set hidden_sections = $1 where user_id = $2 and organization_id = $3", [sections, officeId, org()]));
    await hide(["quotes"]);
    try {
      expect((await as.office.from("quote_attachments").select("id").eq("id", attachment!.id)).data).toEqual([]);
      expect((await as.office.rpc("job_file_quote_reference_ok", { p_org: org(), p_kind: "customer_po", p_path: poPath, p_source: attachment!.id })).data).toBe(true);
      // The row convert_sales_order (058) writes for each quote file: a drawing reference, made a customer-PO reference by 067's trigger.
      const copy = await as.office.from("job_files").insert({ organization_id: org(), job_id: job!.id, kind: "drawing", ref: "po", file_name: "po.pdf", storage_bucket: "quote-attachments", storage_path: poPath, source_attachment_id: attachment!.id });
      expect(copy.error).toBeNull();
    } finally {
      await hide([]);
    }
    expect((await as.workshop.from("job_files").select("kind").eq("job_id", job!.id)).data).toEqual([{ kind: "customer_po" }]);
    expect((await as.workshop.rpc("job_file_quote_reference_ok", { p_org: org(), p_kind: "customer_po", p_path: poPath, p_source: attachment!.id })).data).toBe(false);
  });

  // Finding 2: before 067's rule the workshop could list any file of its company's quote folder on a job and then open it.
  it("the workshop can't put an arbitrary quote file on a job, so can't open it", async () => {
    seq += 1;
    const ref = `QPO-${world.runId}-${seq}`;
    const secret = `${org()}/${ref}/custpo.pdf`;
    expect((await as.office.storage.from("quote-attachments").upload(secret, PDF, PDF_OPTIONS)).error).toBeNull();
    const { data: attachment } = await as.office.from("quote_attachments").insert({ organization_id: org(), quote_ref: ref, file_path: secret, file_name: "custpo.pdf" }).select("id").single();
    const { data: job } = await adminClient().from("jobs").insert({ organization_id: org(), job_no: `J-ARB-${seq}-${world.runId}`, customer: "PO Co" }).select("id").single();
    const row = { organization_id: org(), job_id: job!.id, kind: "drawing", ref: "x", file_name: "custpo.pdf", storage_bucket: "quote-attachments", storage_path: secret };
    expect((await as.workshop.from("job_files").insert(row)).error?.code).toBe("42501");
    expect((await as.workshop.from("job_files").insert({ ...row, source_attachment_id: attachment!.id })).error?.code).toBe("42501");
    expect((await as.workshop.storage.from("quote-attachments").download(secret)).error).not.toBeNull();
    // Admin and office only for a real quote file of the company named by id and path; never a path no quote file has.
    expect((await as.admin.from("job_files").insert({ ...row, storage_path: `${org()}/${ref}/none.pdf`, file_name: "none.pdf" })).error?.code).toBe("42501");
    expect((await as.office.from("job_files").insert({ ...row, source_attachment_id: attachment!.id })).error).toBeNull();
    // The workshop's own drawings still go on the job (job-drawings bucket).
    const own = await as.workshop.from("job_files").insert({ ...row, storage_bucket: "job-drawings", storage_path: `${org()}/${job!.id}/own.pdf`, file_name: "own.pdf" });
    expect(own.error).toBeNull();
  });

  // Finding 3: viewers see a job's drawings, not the customer's PO (as 040 keeps photos from them).
  it("a viewer sees and opens the job's quote drawing but not the customer PO", async () => {
    seq += 1;
    const ref = `QPO-${world.runId}-${seq}`;
    const { data: job } = await adminClient().from("jobs").insert({ organization_id: org(), job_no: `J-VW-${seq}-${world.runId}`, customer: "PO Co", quote_ref: ref }).select("id").single();
    const poPath = `${org()}/${ref}/po.pdf`;
    const drawingPath = `${org()}/${ref}/drawing.pdf`;
    for (const p of [poPath, drawingPath]) expect((await as.office.storage.from("quote-attachments").upload(p, PDF, PDF_OPTIONS)).error).toBeNull();
    expect((await as.office.from("quote_attachments").insert({ organization_id: org(), quote_ref: ref, file_path: poPath, file_name: "po.pdf", kind: "customer_po" })).error).toBeNull();
    const { data: drawing } = await as.office.from("quote_attachments").insert({ organization_id: org(), quote_ref: ref, file_path: drawingPath, file_name: "drawing.pdf" }).select("id").single();
    expect((await as.office.from("job_files").insert({ organization_id: org(), job_id: job!.id, kind: "drawing", ref: "drawing", file_name: "drawing.pdf", storage_bucket: "quote-attachments", storage_path: drawingPath, source_attachment_id: drawing!.id })).error).toBeNull();
    expect((await as.viewer.from("job_files").select("kind").eq("job_id", job!.id)).data).toEqual([{ kind: "drawing" }]);
    expect((await as.viewer.storage.from("quote-attachments").download(drawingPath)).error).toBeNull();
    expect((await as.viewer.storage.from("quote-attachments").download(poPath)).error).not.toBeNull();
    expect(((await as.workshop.from("job_files").select("kind").eq("job_id", job!.id)).data ?? []).map((f) => f.kind).sort()).toEqual(["customer_po", "drawing"]);
    expect((await as.workshop.storage.from("quote-attachments").download(poPath)).error).toBeNull();
  });
});

describe("a draft invoice corrected before it is issued", () => {
  async function draft(tenant: "alpha" | "beta" = "alpha", jobId: string | null = null) {
    const client = tenant === "alpha" ? as.office : betaAdmin;
    const { data, error } = await client.rpc("create_with_lines", {
      p_parent: "invoices",
      p_header: { customer: "Bill Co", description: "Part A", quantity: 2, unit_price: 50, subtotal: 200, carriage: 0, vat: 40, total: 240, vat_enabled: true, carriage_vat: true, invoice_date: "2026-10-18", due_date: "2026-11-17", status: "draft", amount_paid: 0, ...(jobId ? { job_id: jobId } : {}) },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Part A", quantity: 2, unit_price: 50, vat_pct: 20 }, { position: 1, description: "Part B", quantity: 1, unit_price: 100, vat_pct: 20 }],
    });
    if (error) throw new Error(error.message);
    return data as string;
  }
  const stamp = async (id: string) => (await adminClient().from("invoices").select("updated_at").eq("id", id).single()).data!.updated_at as string;

  it("lines removed and changed, totals as the lines give, in one step", async () => {
    const id = await draft();
    const { error } = await as.office.rpc("replace_draft_invoice", {
      p_invoice: id, p_expected_updated_at: await stamp(id),
      p_header: { description: "Part A", quantity: 3, unit_price: 45, subtotal: 135, vat: 27, total: 162, carriage: 0 },
      p_lines: [{ description: "Part A", quantity: 3, unit_price: 45, vat_pct: 20 }],
    });
    expect(error).toBeNull();
    const { data: lines } = await adminClient().from("invoice_line_items").select("quantity, unit_price").eq("invoice_id", id);
    expect(lines!.map((l) => [Number(l.quantity), Number(l.unit_price)])).toEqual([[3, 45]]);
    expect(Number((await adminClient().from("invoices").select("total").eq("id", id).single()).data!.total)).toBe(162);
    expect((await as.office.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
  });

  it("refused: wrong totals (nothing changes), a stale copy, an issued invoice, the workshop, another company", async () => {
    const id = await draft();
    const wrong = await as.office.rpc("replace_draft_invoice", { p_invoice: id, p_expected_updated_at: await stamp(id), p_header: { subtotal: 100, vat: 20, total: 999 }, p_lines: [{ description: "Part A", quantity: 2, unit_price: 50, vat_pct: 20 }] });
    expect(wrong.error?.code).toBe("22023");
    expect((await adminClient().from("invoice_line_items").select("id").eq("invoice_id", id)).data).toHaveLength(2);
    expect((await as.office.rpc("replace_draft_invoice", { p_invoice: id, p_expected_updated_at: "2000-01-01T00:00:00Z", p_header: {}, p_lines: [{ description: "x", quantity: 1, unit_price: 1 }] })).error?.code).toBe("PT409");
    expect((await as.workshop.rpc("replace_draft_invoice", { p_invoice: id, p_expected_updated_at: await stamp(id), p_header: {}, p_lines: [{ description: "x", quantity: 1, unit_price: 1 }] })).error).not.toBeNull();
    expect((await betaAdmin.rpc("replace_draft_invoice", { p_invoice: id, p_expected_updated_at: await stamp(id), p_header: {}, p_lines: [{ description: "x", quantity: 1, unit_price: 1 }] })).error).not.toBeNull();
    expect((await as.office.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
    const issued = await as.office.rpc("replace_draft_invoice", { p_invoice: id, p_expected_updated_at: await stamp(id), p_header: {}, p_lines: [{ description: "x", quantity: 1, unit_price: 1 }] });
    expect(issued.error?.code).toBe("42501");
  });

  describe("a delivery note put on its job's draft invoice", () => {
    async function jobWithDraft() {
      seq += 1;
      const { data: job } = await adminClient().from("jobs").insert({ organization_id: org(), job_no: `J-INV-${seq}-${world.runId}`, customer: "Bill Co", inspected_at: new Date().toISOString() }).select("id").single();
      return { jobId: job!.id as string, invoiceId: await draft("alpha", job!.id) };
    }

    it("linked, then sent out: no second draft is made", async () => {
      const { jobId, invoiceId } = await jobWithDraft();
      const dn = await note("alpha", { job_id: jobId, customer: "BILL  co" });
      const linked = await as.office.rpc("link_delivery_note_to_invoice", { p_note: dn, p_invoice: invoiceId });
      expect(linked.error).toBeNull();
      const before = (await adminClient().from("invoices").select("id").eq("organization_id", org())).data!.length;
      expect((await as.office.from("delivery_notes").update({ status: "despatched" }).eq("id", dn)).error).toBeNull();
      expect((await adminClient().from("invoices").select("id").eq("organization_id", org())).data).toHaveLength(before);
      expect((await adminClient().from("invoice_queue_events").select("id").eq("delivery_note_id", dn)).data).toHaveLength(0);
      expect((await adminClient().from("delivery_notes").select("invoice_id").eq("id", dn).single()).data!.invoice_id).toBe(invoiceId);
    });

    it("refused: another company's invoice, an issued invoice, another job's invoice, the workshop", async () => {
      const { jobId, invoiceId } = await jobWithDraft();
      const dn = await note("alpha", { job_id: jobId, customer: "Bill Co" });
      const betaInvoice = await draft("beta");
      expect((await as.office.rpc("link_delivery_note_to_invoice", { p_note: dn, p_invoice: betaInvoice })).error?.code).toBe("P0002");
      expect((await as.workshop.rpc("link_delivery_note_to_invoice", { p_note: dn, p_invoice: invoiceId })).error?.code).toBe("42501");
      const other = await jobWithDraft();
      expect((await as.office.rpc("link_delivery_note_to_invoice", { p_note: dn, p_invoice: other.invoiceId })).error?.code).toBe("22023");
      expect((await as.office.rpc("issue_invoice", { p_invoice: invoiceId })).error).toBeNull();
      expect((await as.office.rpc("link_delivery_note_to_invoice", { p_note: dn, p_invoice: invoiceId })).error?.code).toBe("42501");
      expect((await adminClient().from("delivery_notes").select("invoice_id").eq("id", dn).single()).data!.invoice_id).toBeNull();
    });
  });
});
