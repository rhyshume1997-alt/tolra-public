/**
 * Approval count = approval queue (audit B7a: D28). Snoozed drafts (skipped_until in the future) aren't in the queue,
 * so they aren't counted either; an expired snooze or none is both listed and counted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { awaitingApproval } from "@/lib/approval-queue";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  const org = world.tenants.alpha.id;
  const hour = 3_600_000;
  const row = (subject: string, skipped_until: string | null, status = "drafted") =>
    ({ organization_id: org, to_email: "buyer@example.test", subject, body: "Synthetic.", related_to_type: "invoice", status, skipped_until });
  const { error } = await adminClient().from("email_history").insert([
    row("never snoozed", null),
    row("snooze expired", new Date(Date.now() - hour).toISOString()),
    row("snoozed until tomorrow", new Date(Date.now() + 24 * hour).toISOString()),
    row("already sent", null, "sent_manually"),
  ]);
  expect(error).toBeNull();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("approval count", () => {
  for (const role of ["admin", "office"] as const) {
    it(`${role}: the count equals the queue, and snoozed drafts are in neither`, async () => {
      const client = await signedInClient(world.tenants.alpha.users[role]);
      const now = new Date().toISOString();
      const list = await awaitingApproval(client.from("email_history").select("subject"), now);
      const count = await awaitingApproval(client.from("email_history").select("*", { count: "exact", head: true }), now);
      expect(list.error).toBeNull();
      expect(count.error).toBeNull();
      expect((list.data ?? []).map((r) => r.subject).sort()).toEqual(["never snoozed", "snooze expired"]);
      expect(count.count).toBe(2);
    });
  }

  it("the other company counts none of them", async () => {
    const client = await signedInClient(world.tenants.beta.users.admin);
    const count = await awaitingApproval(client.from("email_history").select("*", { count: "exact", head: true }));
    expect(count.count).toBe(0);
  });
});
