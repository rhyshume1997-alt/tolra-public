/**
 * Lists beyond the API's 1,000-row cap (audit B6: D10), through the real REST path with RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchAll } from "@/lib/fetch-all";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
const COUNT = 2_300;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  const org = world.tenants.alpha.id;
  for (let start = 0; start < COUNT; start += 500) {
    const batch = Array.from({ length: Math.min(500, COUNT - start) }, (_, i) => ({ organization_id: org, job_no: `J-V${start + i}`, customer: "Volume" }));
    const { error } = await adminClient().from("jobs").insert(batch);
    if (error) throw new Error(error.message);
  }
}, 120_000);

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("more rows than one request returns", () => {
  it("a single request is capped; fetchAll returns every row exactly once", async () => {
    const client = await signedInClient(world.tenants.alpha.users.office);
    const single = await client.from("jobs").select("id");
    expect(single.data?.length).toBe(1_000);
    const { rows, truncated } = await fetchAll((from, to) => client.from("jobs").select("id, job_no").order("created_at", { ascending: false }).order("id").range(from, to));
    expect(truncated).toBe(false);
    expect(rows).toHaveLength(COUNT);
    expect(new Set(rows.map((r) => r.id)).size).toBe(COUNT);
  });

  it("a job created while paging doesn't cause a missing or duplicated row", async () => {
    const client = await signedInClient(world.tenants.alpha.users.office);
    let pages = 0;
    const { rows } = await fetchAll(async (from, to) => {
      pages += 1;
      if (pages === 2) await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: "J-V-NEW", customer: "Volume" });
      return client.from("jobs").select("id, job_no").order("created_at", { ascending: false }).order("id").range(from, to);
    });
    const numbers = rows.map((r) => r.job_no);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (let i = 0; i < COUNT; i += 1) expect(numbers).toContain(`J-V${i}`);
  });

  it("the other company sees none of them", async () => {
    const beta = await signedInClient(world.tenants.beta.users.admin);
    const { rows } = await fetchAll((from, to) => beta.from("jobs").select("id").order("id").range(from, to));
    expect(rows).toHaveLength(0);
  });
});
