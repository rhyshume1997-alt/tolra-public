/**
 * "Show credit notes in Balance due on invoice PDFs" lives in the company profile (organization_settings.company_profile, no
 * migration). Only an admin can change the profile, on the server too: office, workshop and viewer are refused when they
 * save it through the API, and the other company's admin can't touch it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCompanyProfile } from "@/lib/company";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const stored = async (tenant: "alpha" | "beta" = "alpha") =>
  (await adminClient().from("organization_settings").select("company_profile").eq("organization_id", world.tenants[tenant].id).single()).data!.company_profile as Record<string, unknown>;
const save = async (client: SupabaseClient, value: boolean, tenant: "alpha" | "beta" = "alpha") =>
  client.from("organization_settings").update({ company_profile: { ...(await stored(tenant)), showCreditsInBalance: value } }).eq("organization_id", world.tenants[tenant].id).select("organization_id");

describe("the credit-notes-in-balance setting", () => {
  it("is off by default", async () => {
    expect(parseCompanyProfile(await stored())?.showCreditsInBalance).toBe(false);
  });

  it("office, workshop and viewer can't switch it on; nothing changes", async () => {
    for (const role of ["office", "workshop", "viewer"]) {
      const result = await save(as[role], true);
      expect({ role, saved: !result.error && (result.data ?? []).length > 0 }).toEqual({ role, saved: false });
    }
    expect((await stored()).showCreditsInBalance).toBeUndefined();
  });

  it("another company's admin can't change it", async () => {
    const result = await save(as.betaAdmin, true, "alpha");
    expect((result.data ?? []).length).toBe(0);
    expect((await stored()).showCreditsInBalance).toBeUndefined();
  });

  it("an admin can switch it on and off, and only that company's profile changes", async () => {
    expect((await save(as.admin, true)).error).toBeNull();
    expect(parseCompanyProfile(await stored())?.showCreditsInBalance).toBe(true);
    expect(parseCompanyProfile(await stored("beta"))?.showCreditsInBalance).toBe(false);
    // Office still can't switch it off again.
    const off = await save(as.office, false);
    expect(Boolean(off.error) || (off.data ?? []).length === 0).toBe(true);
    expect(parseCompanyProfile(await stored())?.showCreditsInBalance).toBe(true);
    expect((await save(as.admin, false)).error).toBeNull();
    expect(parseCompanyProfile(await stored())?.showCreditsInBalance).toBe(false);
  });
});
