/**
 * Worksheet version and required date (audit B5: D7, A12, A4; migration 022).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
let n = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

async function job(extra: Record<string, unknown> = {}) {
  n += 1;
  const { data, error } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-W${n}`, customer: "Shop", ...extra }).select("*").single();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

const read = async (id: unknown) => (await adminClient().from("jobs").select("*").eq("id", id).single()).data as Record<string, unknown>;

describe("worksheet version", () => {
  it("goes up on a worksheet edit, not on a stage or status change, and can't be set by a client", async () => {
    const j = await job();
    expect(j.worksheet_version).toBe(0);
    const workshop = await signedInClient(world.tenants.alpha.users.workshop);
    await workshop.from("jobs").update({ drawing_no: "DWG-1" }).eq("id", j.id);
    expect((await read(j.id)).worksheet_version).toBe(1);
    await workshop.from("jobs").update({ stage: "machining", status: "at_risk" }).eq("id", j.id);
    expect((await read(j.id)).worksheet_version).toBe(1);
    await workshop.from("jobs").update({ worksheet_version: 99 }).eq("id", j.id);
    expect((await read(j.id)).worksheet_version).toBe(1);
  });

  it("compare-and-swap: of two people who loaded the same version, only the first save lands", async () => {
    const j = await job();
    const a = await signedInClient(world.tenants.alpha.users.workshop);
    const b = await signedInClient(world.tenants.alpha.users.office);
    const first = await a.from("jobs").update({ heat_cast_no: "A" }).eq("id", j.id).eq("worksheet_version", 0).select("worksheet_version");
    const second = await b.from("jobs").update({ heat_cast_no: "B" }).eq("id", j.id).eq("worksheet_version", 0).select("worksheet_version");
    expect(first.data).toEqual([{ worksheet_version: 1 }]);
    expect(second.data).toEqual([]);
    expect((await read(j.id)).heat_cast_no).toBe("A");
  });

  it("a viewer's save writes nothing (zero rows, never success)", async () => {
    const j = await job();
    const viewer = await signedInClient(world.tenants.alpha.users.viewer);
    const { data } = await viewer.from("jobs").update({ drawing_no: "X" }).eq("id", j.id).eq("worksheet_version", 0).select("id");
    expect(data ?? []).toEqual([]);
    expect((await read(j.id)).drawing_no).toBeNull();
  });
});

describe("one required date", () => {
  it("changing either date sets the other; a new job with only one gets both", async () => {
    const j = await job({ due_date: "2026-11-01" });
    expect([j.date_required, j.due_date]).toEqual(["2026-11-01", "2026-11-01"]);
    await adminClient().from("jobs").update({ date_required: "2026-11-15" }).eq("id", j.id);
    expect([(await read(j.id)).date_required, (await read(j.id)).due_date]).toEqual(["2026-11-15", "2026-11-15"]);
    await adminClient().from("jobs").update({ due_date: "2026-12-01" }).eq("id", j.id);
    expect([(await read(j.id)).date_required, (await read(j.id)).due_date]).toEqual(["2026-12-01", "2026-12-01"]);
  });
});
