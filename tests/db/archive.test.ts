/**
 * Archive, never delete (migration 028). Admin and office can archive or keep a record active; workshop and viewer
 * can't; nobody can archive another company's record or write the table directly; members only see their own
 * company's choices; the record itself is never changed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
const invoice: Record<"alpha" | "beta", string> = { alpha: "", beta: "" };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const t of ["alpha", "beta"] as const) {
    const { data, error } = await adminClient().from("jobs").insert({ organization_id: world.tenants[t].id, job_no: `J-ARC-${t}-${world.runId}`, customer: "Archive Co" }).select("id").single();
    expect(error).toBeNull();
    invoice[t] = data!.id;
  }
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("set_archive_state", () => {
  it("admin and office archive and unarchive their own company's records; the record is unchanged", async () => {
    const before = (await adminClient().from("jobs").select("*").eq("id", invoice.alpha).single()).data;
    const office = await signedInClient(world.tenants.alpha.users.office);
    expect((await office.rpc("set_archive_state", { p_table: "jobs", p_id: invoice.alpha, p_state: "archived" })).error).toBeNull();
    expect((await office.from("record_archive_state").select("state").eq("record_id", invoice.alpha).single()).data).toEqual({ state: "archived" });
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    expect((await admin.rpc("set_archive_state", { p_table: "jobs", p_id: invoice.alpha, p_state: "active" })).error).toBeNull();
    expect((await admin.from("record_archive_state").select("state").eq("record_id", invoice.alpha).single()).data).toEqual({ state: "active" });
    expect((await admin.rpc("set_archive_state", { p_table: "jobs", p_id: invoice.alpha, p_state: "auto" })).error).toBeNull();
    expect((await admin.from("record_archive_state").select("state").eq("record_id", invoice.alpha)).data).toEqual([]);
    expect((await adminClient().from("jobs").select("*").eq("id", invoice.alpha).single()).data).toEqual(before);
  });

  it("workshop and viewer can't archive", async () => {
    for (const role of ["workshop", "viewer"] as const) {
      const client = await signedInClient(world.tenants.alpha.users[role]);
      expect((await client.rpc("set_archive_state", { p_table: "jobs", p_id: invoice.alpha, p_state: "archived" })).error).toMatchObject({ code: "42501" });
    }
  });

  it("another company's record is refused as not found, and the table can't be written directly", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    expect((await admin.rpc("set_archive_state", { p_table: "jobs", p_id: invoice.beta, p_state: "archived" })).error).toMatchObject({ code: "P0002" });
    const direct = await admin.from("record_archive_state").insert({ organization_id: world.tenants.alpha.id, record_table: "jobs", record_id: invoice.alpha, state: "archived" });
    expect(direct.error).not.toBeNull();
    // A table outside the list is refused (customers joined it in 097: tests/db/customer-archive-097.test.ts).
    expect((await admin.rpc("set_archive_state", { p_table: "suppliers", p_id: invoice.alpha, p_state: "archived" })).error).toMatchObject({ code: "22023" });
  });

  it("members only see their own company's archive choices", async () => {
    const betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    expect((await betaAdmin.rpc("set_archive_state", { p_table: "jobs", p_id: invoice.beta, p_state: "archived" })).error).toBeNull();
    const alphaAdmin = await signedInClient(world.tenants.alpha.users.admin);
    expect((await alphaAdmin.from("record_archive_state").select("record_id").eq("record_id", invoice.beta)).data).toEqual([]);
  });

  it("the age setting is limited to 1..120 months", async () => {
    const bad = await adminClient().from("organization_settings").upsert({ organization_id: world.tenants.alpha.id, archive_after_months: 0 });
    expect(bad.error).not.toBeNull();
    const good = await adminClient().from("organization_settings").upsert({ organization_id: world.tenants.alpha.id, archive_after_months: 72 });
    expect(good.error).toBeNull();
  });
});
