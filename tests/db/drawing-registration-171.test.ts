/**
 * Inputs: release 171 and the disposable Supabase stack. Outputs: Storage API and revision assertions.
 * Restore the prior policies and remove only this test's synthetic data and objects.
 */
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

const bucket = "job-drawings";
const cutoff = "2025-01-01T00:00:00Z";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const readSql = (path: string) => readFileSync(path, "utf8");
const release = readSql("supabase/release/171_drawing_registration.release.sql");
const rollback = readSql("supabase/release/171_drawing_registration.rollback.sql");
const verify = readSql("supabase/verify/drawing_registration_171.sql");
const uploaded: string[] = [];

let world: Awaited<ReturnType<typeof createSyntheticWorld>>;
let admin: SupabaseClient;
let workshop: SupabaseClient;
let viewer: SupabaseClient;
let otherViewer: SupabaseClient;
let applied159 = false;
let applied171 = false;
let jobId: string;
let orgId: string;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  const { alpha, beta } = world.tenants;
  [admin, workshop, viewer, otherViewer] = await Promise.all([
    signedInClient(alpha.users.admin),
    signedInClient(alpha.users.workshop),
    signedInClient(alpha.users.viewer),
    signedInClient(beta.users.viewer),
  ]);
  orgId = alpha.id;
  const job = await adminClient().from("jobs").insert({
    organization_id: orgId, job_no: "DWG-171", customer: "Drawing test", description: "Bracket",
  }).select("id").single();
  expect(job.error).toBeNull();
  jobId = job.data!.id;

  await withDb(async (db) => {
    const state = await db.query(verify);
    expect(state.rows[0].ok).toBe(false);
    const prior = await db.query(`
      SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname = 'job drawings org update'
    `);
    if (prior.rows[0]?.qual !== "false") {
      await db.query(readSql("supabase/release/159_drawings_update_roles.release.sql"));
      applied159 = true;
    }
    await expect(db.query(release)).rejects.toThrow("verified migration 034 cutoff before applying");
    await db.query("ROLLBACK");
    await db.query("SELECT set_config('tolra.drawing_legacy_before', $1, false)", [cutoff]);
    await db.query(release);
    applied171 = true;
    const installed = (await db.query(verify)).rows;
    expect(installed[0].ok).toBe(true);
    await db.query("RESET tolra.drawing_legacy_before");
    await db.query(release);
    expect((await db.query(verify)).rows).toEqual(installed);
    await db.query("SET tolra.drawing_legacy_before = '2025-01-02T00:00:00Z'");
    await expect(db.query(release)).rejects.toThrow("different legacy cutoff");
    await db.query("ROLLBACK");
  });
});

afterAll(async () => {
  try {
    if (uploaded.length) await adminClient().storage.from(bucket).remove(uploaded);
    if (world) await destroySyntheticWorld(world.runId);
  } finally {
    if (applied171 || applied159) await withDb(async (db) => {
      if (applied171) {
        await db.query(rollback);
        await db.query(rollback);
        expect((await db.query(verify)).rows[0].ok).toBe(false);
      }
      if (applied159) await db.query(readSql("supabase/release/159_drawings_update_roles.rollback.sql"));
    });
  }
});

const folder = () => `${orgId}/${jobId}`;
const fileRow = (path: string, name: string) => ({
  organization_id: orgId, job_id: jobId, kind: "drawing", ref: "Bracket",
  storage_bucket: bucket, storage_path: path, file_name: name,
});

async function upload(client: SupabaseClient, path: string) {
  const result = await client.storage.from(bucket).upload(path, png, { contentType: "image/png" });
  expect(result.error).toBeNull();
  uploaded.push(path);
}

async function expectHidden(path: string) {
  const slash = path.lastIndexOf("/");
  for (const client of [workshop, viewer]) {
    const storage = client.storage.from(bucket);
    const list = await storage.list(path.slice(0, slash));
    expect(list.error).toBeNull();
    expect(list.data?.map((file) => file.name)).not.toContain(path.slice(slash + 1));
    expect((await storage.createSignedUrl(path, 60)).error).not.toBeNull();
    expect((await storage.download(path)).error).not.toBeNull();
  }
  expect((await adminClient().storage.from(bucket).download(path)).error).toBeNull();
}

async function expectReadable(path: string) {
  for (const client of [workshop, viewer]) {
    const storage = client.storage.from(bucket);
    const slash = path.lastIndexOf("/");
    const list = await storage.list(path.slice(0, slash));
    expect(list.error).toBeNull();
    expect(list.data?.map((file) => file.name)).toContain(path.slice(slash + 1));
    expect((await storage.createSignedUrl(path, 60)).error).toBeNull();
    expect((await storage.download(path)).error).toBeNull();
  }
  expect((await otherViewer.storage.from(bucket).createSignedUrl(path, 60)).error).not.toBeNull();
}

describe("release 171 drawing registration", () => {
  it("hides failed registrations on both paths and opens a successfully registered drawing", async () => {
    const path = `${folder()}/drawings/bracket.png`;
    const priorClientPath = `${folder()}/1730000000000-unregistered.png`;
    for (const candidate of [path, priorClientPath]) {
      await upload(workshop, candidate);
      const failed = await workshop.from("job_files").insert({ ...fileRow(candidate, "bracket.png"), ref: "" });
      expect(failed.error?.code).toBe("23514");
      await expectHidden(candidate);
    }
    expect((await workshop.from("job_files").insert(fileRow(path, "bracket.png"))).error).toBeNull();
    await expectReadable(path);
    await expectHidden(priorClientPath);
  });

  it("keeps the failed revision private and publishes a successful bump with its history", async () => {
    const firstPath = `${folder()}/drawings/revision-a.png`;
    const nextPath = `${folder()}/drawings/revision-b.png`;
    await upload(admin, firstPath);
    const first = await admin.from("job_files").insert({
      ...fileRow(firstPath, "revision-a.png"), ref: "Revision test", revision: "A",
    }).select("id").single();
    expect(first.error).toBeNull();
    await upload(admin, nextPath);
    const bump = (revision: string) => admin.rpc("bump_drawing_revision", {
      p_file: first.data!.id, p_revision: revision, p_file_name: "revision-b.png", p_storage_path: nextPath,
    });
    expect((await bump("a")).error?.code).toBe("22023");
    await expectHidden(nextPath);
    await expectReadable(firstPath);

    const revision = await bump("B");
    expect(revision.error).toBeNull();
    const history = await workshop.from("job_files").select("id, revision, superseded_by, superseded_at")
      .eq("job_id", jobId).eq("ref", "Revision test").order("revision");
    expect(history.error).toBeNull();
    expect(history.data).toEqual([
      { id: first.data!.id, revision: "A", superseded_by: revision.data, superseded_at: expect.any(String) },
      { id: revision.data, revision: "B", superseded_by: null, superseded_at: null },
    ]);
    await expectReadable(nextPath);
    await expectReadable(firstPath);
  });

  it("lists and opens a legacy drawing with a pre-034 Storage timestamp and no registration", async () => {
    const name = "1730000000000-legacy.png";
    const path = `${folder()}/${name}`;
    await upload(workshop, path);
    await withDb((db) => db.query(
      "UPDATE storage.objects SET created_at = $1::timestamptz - interval '1 second' WHERE bucket_id = $2 AND name = $3",
      [cutoff, bucket, path],
    ));
    const list = await workshop.storage.from(bucket).list(folder());
    expect(list.error).toBeNull();
    expect(list.data?.map((file) => file.name)).toContain(name);
    expect((await workshop.from("job_files").select("id").eq("storage_path", path)).data).toEqual([]);
    await expectReadable(path);
  });

  it("allows an attached certificate through its own job record", async () => {
    const path = `${folder()}/certs/heat.png`;
    await upload(workshop, path);
    await expectHidden(path);
    const result = await workshop.from("job_files").insert({ ...fileRow(path, "heat.png"), ref: "Heat 001", kind: "cert" });
    expect(result.error).toBeNull();
    await expectReadable(path);
  });
  it("allows a recorded inspection attachment through its own job record", async () => {
    const path = `${folder()}/inspection/pass.png`;
    await upload(admin, path);
    await expectHidden(path);
    await withDb((db) => db.query(
      `INSERT INTO public.job_inspections
        (organization_id, job_id, result, release_decision, measured_notes,
         attachment_path, attachment_name, inspector_name, worksheet_version)
       VALUES ($1, $2, 'pass', 'released', 'In tolerance', $3, 'pass.png', 'Test inspector', 1)`,
      [orgId, jobId, path],
    ));
    await expectReadable(path);
  });
});
