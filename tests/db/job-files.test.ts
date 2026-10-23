/**
 * Drawings carried from quote to job, with revisions, and the material cert pack (migration 034, W3). Converting an order
 * gives the job a reference to every file attached to the quote (nothing is copied); the shop floor can open exactly those
 * files; a newer revision supersedes the older one; certs attach to the job. Everything stays inside one company.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let n = 0;
const uploaded: { bucket: string; path: string }[] = [];

// 1x1 PNG: the buckets accept image/png.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  for (const { bucket, path } of uploaded) await adminClient().storage.from(bucket).remove([path]);
  if (world) await destroySyntheticWorld(world.runId);
});

async function put(bucket: string, path: string) {
  const { error } = await adminClient().storage.from(bucket).upload(path, PNG, { contentType: "image/png" });
  if (error) throw new Error(error.message);
  uploaded.push({ bucket, path });
}

/** An accepted quote with two attached drawings, and an order for it. */
async function orderWithDrawings() {
  n += 1;
  const service = adminClient();
  const org = world.tenants.alpha.id;
  const ref = `QUO-DWG-${world.runId}-${n}`;
  const { data: quote, error } = await service.from("quotes").insert({ organization_id: org, quote_ref: ref, customer: "Drawing Co", status: "draft", total_value: 0 }).select("id").single();
  if (error) throw new Error(error.message);
  expect((await service.from("quote_line_items").insert({ organization_id: org, quote_id: quote.id, position: 0, description: "Bracket", quantity: 2, unit_price: 50, vat_pct: 0 })).error).toBeNull();
  expect((await service.from("quotes").update({ total_value: 100, vat_enabled: false }).eq("id", quote.id)).error).toBeNull();
  expect((await service.from("quotes").update({ status: "accepted" }).eq("id", quote.id)).error).toBeNull();
  const files = [`${org}/${ref}/100-bracket-A.png`, `${org}/${ref}/101-notes.png`];
  for (const path of files) await put("quote-attachments", path);
  const { data: attachments, error: attachError } = await service.from("quote_attachments").insert(files.map((file_path) => ({ organization_id: org, quote_ref: ref, file_path, file_name: file_path.split("/").pop()!.replace(/^\d+-/, "") }))).select("id, file_path");
  if (attachError) throw new Error(attachError.message);
  const { data: order } = await service.from("sales_orders").insert({ organization_id: org, so_number: `PO-DWG-${n}`, customer: "Drawing Co", quote_id: quote.id, quote_ref: ref, total_value: 100, status: "open" }).select("id").single();
  return { order: order!.id as string, ref, files, attachments: attachments! };
}

const filesOf = async (jobId: string, kind = "drawing") => ((await adminClient().from("job_files").select("*").eq("job_id", jobId).eq("kind", kind).order("created_at").order("file_name")).data ?? []) as Record<string, unknown>[];

describe("conversion carries the quote's drawings", () => {
  it("gives the job a reference to each attached file, in the same company folder, copying nothing", async () => {
    const o = await orderWithDrawings();
    const converted = await as.office.rpc("convert_sales_order", { p_order: o.order });
    expect(converted.error).toBeNull();
    const rows = await filesOf(converted.data.job_id);
    expect(rows.map((r) => r.storage_path).sort()).toEqual([...o.files].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ kind: "drawing", storage_bucket: "quote-attachments", organization_id: world.tenants.alpha.id, revision: null, superseded_at: null });
      expect(o.attachments.map((a) => a.id)).toContain(row.source_attachment_id);
    }
    expect(rows.map((r) => r.file_name).sort()).toEqual(["bracket-A.png", "notes.png"]);
    expect(rows.map((r) => r.ref).sort()).toEqual(["bracket-A", "notes"]);
    // The job's own folder was not written to.
    const own = await adminClient().storage.from("job-drawings").list(`${world.tenants.alpha.id}/${converted.data.job_id}`);
    expect(own.data ?? []).toEqual([]);
  });

  it("converting again returns the same job and adds nothing; an order with no quote has none", async () => {
    const o = await orderWithDrawings();
    const first = await as.admin.rpc("convert_sales_order", { p_order: o.order });
    const again = await as.admin.rpc("convert_sales_order", { p_order: o.order });
    expect(again.data).toMatchObject({ job_id: first.data.job_id, created: false });
    expect(await filesOf(first.data.job_id)).toHaveLength(2);
    const { data: plain } = await adminClient().from("sales_orders").insert({ organization_id: world.tenants.alpha.id, so_number: `PO-NODWG-${world.runId}`, customer: "X", total_value: 1, status: "open" }).select("id").single();
    const job = await as.admin.rpc("convert_sales_order", { p_order: plain!.id });
    expect(await filesOf(job.data.job_id)).toEqual([]);
  });

  it("another quote's files, and another company's, are not carried", async () => {
    const mine = await orderWithDrawings();
    const other = await orderWithDrawings();
    const job = await as.admin.rpc("convert_sales_order", { p_order: mine.order });
    expect((await filesOf(job.data.job_id)).map((r) => r.storage_path)).not.toContain(other.files[0]);
    // A beta attachment with the same quote reference is not picked up.
    await adminClient().from("quote_attachments").insert({ organization_id: world.tenants.beta.id, quote_ref: mine.ref, file_path: `${world.tenants.beta.id}/${mine.ref}/x.png`, file_name: "x.png" });
    const { data: second } = await adminClient().from("sales_orders").insert({ organization_id: world.tenants.alpha.id, so_number: `PO-DWG-SAME-${world.runId}`, customer: "Drawing Co", quote_ref: mine.ref, total_value: 1, status: "open" }).select("id").single();
    const again = await as.admin.rpc("convert_sales_order", { p_order: second!.id });
    expect((await filesOf(again.data.job_id)).map((r) => r.storage_path).sort()).toEqual([...mine.files].sort());
  });
});

describe("the shop floor opens the referenced files and nothing else", () => {
  it("workshop and viewer can sign a link to a drawing the job refers to, but not to another file in the quote's folder", async () => {
    const o = await orderWithDrawings();
    const converted = await as.admin.rpc("convert_sales_order", { p_order: o.order });
    expect(converted.error).toBeNull();
    const unreferenced = `${world.tenants.alpha.id}/${o.ref}/102-unreferenced.png`;
    await put("quote-attachments", unreferenced);
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      expect((await as[role].storage.from("quote-attachments").createSignedUrl(o.files[0], 60)).error, `${role} referenced`).toBeNull();
    }
    for (const role of ["workshop", "viewer"]) {
      expect((await as[role].storage.from("quote-attachments").createSignedUrl(unreferenced, 60)).error, `${role} unreferenced`).not.toBeNull();
    }
    // Another company's people can't open it, even though a job refers to it.
    expect((await as.betaAdmin.storage.from("quote-attachments").createSignedUrl(o.files[0], 60)).error).not.toBeNull();
  });
});

describe("revisions", () => {
  async function jobWithDrawing(client: SupabaseClient = as.admin) {
    const o = await orderWithDrawings();
    const converted = await client.rpc("convert_sales_order", { p_order: o.order });
    const [first] = (await filesOf(converted.data.job_id)).filter((r) => r.file_name === "bracket-A.png");
    return { jobId: converted.data.job_id as string, drawing: first.id as string };
  }

  it("a revision label can be set, and a newer revision supersedes the old one (the latest is the current row)", async () => {
    const { jobId, drawing } = await jobWithDrawing();
    // Approving a revision is for admins: office and workshop can't label a drawing or replace it with a newer one.
    const path = `${world.tenants.alpha.id}/${jobId}/200-bracket-B.png`;
    await put("job-drawings", path);
    for (const role of ["office", "workshop"]) {
      expect((await as[role].from("job_files").update({ revision: "A" }).eq("id", drawing).select("id")).error, `${role} label`).toMatchObject({ code: "42501" });
      expect((await as[role].rpc("bump_drawing_revision", { p_file: drawing, p_revision: "B", p_file_name: "bracket-B.png", p_storage_path: path })).error, `${role} bump`).toMatchObject({ code: "42501" });
    }
    expect((await as.admin.from("job_files").update({ revision: "A" }).eq("id", drawing).select("id")).data).toHaveLength(1);
    const bumped = await as.admin.rpc("bump_drawing_revision", { p_file: drawing, p_revision: "B", p_file_name: "bracket-B.png", p_storage_path: path });
    expect(bumped.error).toBeNull();
    const rows = await filesOf(jobId);
    const current = rows.filter((r) => r.superseded_at === null && r.ref === "bracket-A");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ id: bumped.data, revision: "B", storage_bucket: "job-drawings", storage_path: path });
    expect(rows.find((r) => r.id === drawing)).toMatchObject({ revision: "A", superseded_by: bumped.data });
    expect((rows.find((r) => r.id === drawing) as { superseded_at: string | null }).superseded_at).toBeTruthy();
  });

  it("refuses the same revision, a replaced drawing, a missing label, a file from elsewhere, and a viewer", async () => {
    const { jobId, drawing } = await jobWithDrawing();
    await as.admin.from("job_files").update({ revision: "A" }).eq("id", drawing);
    const path = `${world.tenants.alpha.id}/${jobId}/300-bracket-B.png`;
    await put("job-drawings", path);
    const call = (client: SupabaseClient, revision: string | null, file = path, id = drawing) => client.rpc("bump_drawing_revision", { p_file: id, p_revision: revision, p_file_name: "b.png", p_storage_path: file });
    expect((await call(as.admin, "a")).error).toMatchObject({ code: "22023" });
    expect((await call(as.admin, "  ")).error).toMatchObject({ code: "22023" });
    expect((await call(as.admin, "B", `${world.tenants.beta.id}/${jobId}/x.png`)).error).toMatchObject({ code: "22023" });
    expect((await call(as.admin, "B", `${world.tenants.alpha.id}/${crypto.randomUUID()}/x.png`)).error).toMatchObject({ code: "22023" });
    expect((await call(as.viewer, "B")).error).toMatchObject({ code: "42501" });
    expect((await call(as.admin, "B")).error).toBeNull();
    expect((await call(as.admin, "C", path)).error).toMatchObject({ code: "22023" }); // the first one has been replaced
  });

  it("another company can't read, change or bump the drawings", async () => {
    const { jobId, drawing } = await jobWithDrawing();
    expect((await as.betaAdmin.from("job_files").select("id").eq("job_id", jobId)).data).toEqual([]);
    expect((await as.betaAdmin.from("job_files").update({ revision: "Z" }).eq("id", drawing).select("id")).data ?? []).toEqual([]);
    const path = `${world.tenants.beta.id}/${jobId}/x.png`;
    expect((await as.betaAdmin.rpc("bump_drawing_revision", { p_file: drawing, p_revision: "Z", p_file_name: "x.png", p_storage_path: path })).error).toMatchObject({ code: "P0002" });
    // Rows can't point at a file in someone else's folder, or at someone else's job.
    const forged = { organization_id: world.tenants.beta.id, job_id: jobId, kind: "drawing", ref: "x", file_name: "x.png", storage_bucket: "job-drawings", storage_path: path };
    expect((await as.betaAdmin.from("job_files").insert(forged)).error).not.toBeNull();
    const alphaFolder = { ...forged, organization_id: world.tenants.alpha.id, storage_path: `${world.tenants.beta.id}/${jobId}/x.png` };
    expect((await as.admin.from("job_files").insert(alphaFolder)).error).not.toBeNull();
    expect(await filesOf(jobId)).toHaveLength(2);
  });
});

describe("an attached file is evidence", () => {
  async function jobWithDrawing() {
    const o = await orderWithDrawings();
    const converted = await as.admin.rpc("convert_sales_order", { p_order: o.order });
    const [first] = (await filesOf(converted.data.job_id)).filter((r) => r.file_name === "bracket-A.png");
    return { jobId: converted.data.job_id as string, drawing: first.id as string, files: o.files };
  }
  const jobRow = async (id: string) => (await adminClient().from("jobs").select("stage, inspected_at, inspected_by, worksheet_version").eq("id", id).single()).data!;

  it("a row's file, name and place never change, a revision is set once, nothing marks a file replaced by hand, and drawings are never removed", async () => {
    const { jobId, drawing } = await jobWithDrawing();
    for (const role of ["admin", "office", "workshop"]) {
      for (const change of [{ file_name: "other.png" }, { storage_path: `${world.tenants.alpha.id}/${jobId}/other.png` }, { ref: "other" }, { kind: "cert" }, { job_id: crypto.randomUUID() }]) {
        const result = await as[role].from("job_files").update(change).eq("id", drawing).select("id");
        expect(result.error?.code ?? "none", `${role} ${JSON.stringify(change)}`).not.toBe("none");
        expect(result.data ?? []).toEqual([]);
      }
      expect((await as[role].from("job_files").update({ superseded_at: new Date().toISOString() }).eq("id", drawing).select("id")).error, `${role} supersede`).toMatchObject({ code: "42501" });
      const removed = await as[role].from("job_files").delete().eq("id", drawing).select("id");
      expect(removed.error?.code === "42501" || (removed.data ?? []).length === 0, `${role} delete`).toBe(true);
    }
    expect((await as.admin.from("job_files").update({ revision: "A" }).eq("id", drawing).select("id")).data).toHaveLength(1);
    // Once labelled, the label is never altered or cleared, even by an admin: the next revision is a new row.
    expect((await as.admin.from("job_files").update({ revision: "Z" }).eq("id", drawing).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.admin.from("job_files").update({ revision: null }).eq("id", drawing).select("id")).error).toMatchObject({ code: "42501" });
    // A row can't be inserted already replaced, or with a revision by anyone but an admin.
    const base = { organization_id: world.tenants.alpha.id, job_id: jobId, kind: "drawing", ref: "extra", file_name: "extra.png", storage_bucket: "job-drawings" };
    expect((await as.admin.from("job_files").insert({ ...base, storage_path: `${world.tenants.alpha.id}/${jobId}/e1.png`, superseded_at: new Date().toISOString() })).error).toMatchObject({ code: "42501" });
    expect((await as.workshop.from("job_files").insert({ ...base, storage_path: `${world.tenants.alpha.id}/${jobId}/e2.png`, revision: "C" })).error).toMatchObject({ code: "42501" });
    expect((await as.workshop.from("job_files").insert({ ...base, storage_path: `${world.tenants.alpha.id}/${jobId}/e3.png` })).error).toBeNull();
  });

  it("the attached files can't be overwritten or deleted in storage by the browser roles", async () => {
    const { files } = await jobWithDrawing();
    for (const role of ["admin", "office"]) {
      const removed = await as[role].storage.from("quote-attachments").remove([files[0]]);
      expect(removed.data ?? [], `${role} remove`).toEqual([]);
      const over = await as[role].storage.from("quote-attachments").update(files[0], PNG, { contentType: "image/png" });
      expect(over.error, `${role} overwrite`).not.toBeNull();
    }
    expect((await adminClient().storage.from("quote-attachments").download(files[0])).error).toBeNull();
  });

  it("a revision change after release withdraws the release and makes an earlier result stale; a plain attachment doesn't", async () => {
    const { jobId, drawing } = await jobWithDrawing();
    await adminClient().from("jobs").update({ started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z" }).eq("id", jobId);
    await adminClient().from("organization_members").update({ can_inspect: true }).eq("user_id", world.tenants.alpha.users.workshop.id).eq("organization_id", world.tenants.alpha.id);
    const pass = async () => recordInspection(as.workshop, { p_job: jobId, p_result: "pass", p_notes: "In tolerance", p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, p_expected_version: (await jobRow(jobId)).worksheet_version });
    expect((await as.admin.from("job_files").update({ revision: "A" }).eq("id", drawing)).error).toBeNull();
    const before = await jobRow(jobId);
    expect((await pass()).error).toBeNull();
    expect(await jobRow(jobId)).toMatchObject({ stage: "complete" });
    // Attaching another drawing without a revision leaves the release alone.
    const extra = { organization_id: world.tenants.alpha.id, job_id: jobId, kind: "drawing", ref: "extra", file_name: "extra.png", storage_bucket: "job-drawings", storage_path: `${world.tenants.alpha.id}/${jobId}/x1.png` };
    expect((await as.workshop.from("job_files").insert(extra)).error).toBeNull();
    expect(await jobRow(jobId)).toMatchObject({ stage: "complete" });
    expect((await jobRow(jobId)).inspected_at).not.toBeNull();
    // The next revision withdraws it, in the same statement, and raises the version.
    const path = `${world.tenants.alpha.id}/${jobId}/400-bracket-B.png`;
    await put("job-drawings", path);
    expect((await as.admin.rpc("bump_drawing_revision", { p_file: drawing, p_revision: "B", p_file_name: "bracket-B.png", p_storage_path: path })).error).toBeNull();
    const after = await jobRow(jobId);
    expect(after).toMatchObject({ stage: "inspection", inspected_at: null, inspected_by: null });
    expect(after.worksheet_version).toBeGreaterThan(before.worksheet_version);
    // A result entered against the version the inspector opened is stale now.
    const stale = await recordInspection(as.workshop, { p_job: jobId, p_result: "pass", p_notes: "Old drawing", p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, p_expected_version: before.worksheet_version });
    expect(stale.error).toMatchObject({ code: "22023" });
    expect(stale.error!.message).toMatch(/changed after you opened it/);
    expect((await pass()).error).toBeNull();
  });

  it("once a delivery note for the job has gone out, its cert pack can't gain or lose a certificate", async () => {
    const { data: job } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-FRZC-${world.runId}`, customer: "Cert Co" }).select("id, job_no").single();
    const cert = (suffix: string) => ({ organization_id: world.tenants.alpha.id, job_id: job!.id, kind: "cert", ref: `Heat ${suffix}`, file_name: `cert-${suffix}.png`, storage_bucket: "job-drawings", storage_path: `${world.tenants.alpha.id}/${job!.id}/certs/${suffix}.png` });
    expect((await as.office.from("job_files").insert(cert("1"))).error).toBeNull();
    expect((await as.office.from("job_files").insert(cert("2"))).error).toBeNull();
    const note = (await adminClient().from("delivery_notes").insert({ organization_id: world.tenants.alpha.id, dn_number: `DLN-FRZC-${world.runId}`, customer: "Cert Co", job_ref: job!.job_no, status: "awaiting" }).select("id").single()).data!;
    // Still awaiting: the pack can change.
    const one = (await filesOf(job!.id, "cert")).find((r) => r.ref === "Heat 2")!;
    expect((await as.office.from("job_files").delete().eq("id", one.id).select("id")).data).toHaveLength(1);
    expect((await adminClient().from("delivery_notes").update({ status: "despatched" }).eq("id", note.id)).error).toBeNull();
    const kept = (await filesOf(job!.id, "cert"))[0];
    for (const role of ["admin", "office"]) {
      expect((await as[role].from("job_files").delete().eq("id", kept.id).select("id")).error, `${role} remove`).toMatchObject({ code: "42501" });
    }
    for (const role of ["admin", "office", "workshop"]) {
      expect((await as[role].from("job_files").insert(cert(`late-${role}`))).error, `${role} add`).toMatchObject({ code: "42501" });
    }
    expect(await filesOf(job!.id, "cert")).toHaveLength(1);
    // Deleting the job itself (admin) still clears its rows.
    expect((await adminClient().from("delivery_notes").delete().eq("id", note.id)).error).toBeNull();
    expect((await as.admin.from("jobs").delete().eq("id", job!.id).select("id")).data).toHaveLength(1);
    expect(await filesOf(job!.id, "cert")).toHaveLength(0);
  });
});

describe("cert pack", () => {
  it("material certificates attach to the job, are read by the company's people, and have no revision", async () => {
    const { data: job } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-CERT-${world.runId}`, customer: "Cert Co" }).select("id").single();
    const path = `${world.tenants.alpha.id}/${job!.id}/certs/1-cert-EN8.png`;
    const cert = { organization_id: world.tenants.alpha.id, job_id: job!.id, kind: "cert", ref: "Heat 12345", file_name: "cert-EN8.png", storage_bucket: "job-drawings", storage_path: path };
    expect((await as.viewer.from("job_files").insert(cert)).error).not.toBeNull();
    expect((await as.workshop.from("job_files").insert(cert)).error).toBeNull();
    expect((await as.workshop.from("job_files").insert({ ...cert, storage_path: `${path}2`, revision: "B" })).error).not.toBeNull(); // certs carry no revision
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      expect((await as[role].from("job_files").select("id").eq("job_id", job!.id).eq("kind", "cert")).data, role).toHaveLength(1);
    }
    expect((await as.betaAdmin.from("job_files").select("id").eq("job_id", job!.id)).data).toEqual([]);
    // Office removes a wrong certificate; workshop can't.
    const id = (await filesOf(job!.id, "cert"))[0].id as string;
    expect((await as.workshop.from("job_files").delete().eq("id", id).select("id")).data ?? []).toEqual([]);
    expect((await as.office.from("job_files").delete().eq("id", id).select("id")).data).toHaveLength(1);
  });
});
