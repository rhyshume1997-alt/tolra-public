import { preparePost144Backend } from "../support/post-144-release-fixture";
// Requires the reviewed proposal on an isolated backend. The verified test fixture prepares releases 145/146 after the baseline.
import { beforeAll, afterAll, expect, it } from "vitest";
import { adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, type SyntheticWorld } from "../support/fixtures";
let world: SyntheticWorld;
beforeAll(async () => { await verifyBackendIdentity(); await preparePost144Backend(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });
it("a new company cannot read another company's setup ticks or customers, or write its progress", async () => {
  const a = await signedInClient(world.tenants.alpha.users.admin);
  const b = await signedInClient(world.tenants.beta.users.admin);
  const beta = world.tenants.beta.id;
  expect((await b.from("company_setup_progress").upsert({ organization_id: beta, step: "company", completed: true })).error).toBeNull();
  expect((await adminClient().from("customers").insert({ organization_id: beta, name: "Private beta customer" })).error).toBeNull();
  const progress = await a.from("company_setup_progress").select("*").eq("organization_id", beta);
  expect(progress.error).toBeNull(); expect(progress.data).toEqual([]);
  const customers = await a.from("customers").select("*").eq("organization_id", beta);
  expect(customers.error).toBeNull(); expect(customers.data).toEqual([]);
  expect((await a.from("company_setup_progress").upsert({ organization_id: beta, step: "people", completed: true })).error).not.toBeNull();
});
