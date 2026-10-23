/**
 * Inbound mail (migration 031): admin/office read the stored messages of their own company; nobody else does; the
 * API roles can't write the table directly; record_inbound_email stores a message once and makes one RFQ for it.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  p_graph_message_id: id,
  p_internet_message_id: `<${id}@example.test>`,
  p_from_address: "buyer@example.test",
  p_from_name: "Pat Buyer",
  p_subject: "Brackets x50",
  p_received_at: "2026-02-03T09:00:00Z",
  p_body_preview: "Please quote 50 brackets",
  p_body_text: "Please quote 50 brackets, drawing attached.",
  ...extra,
});

describe("record_inbound_email", () => {
  it("stores a message and makes one RFQ from it", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const { data, error } = await admin.rpc("record_inbound_email", message(`g-${world.runId}-1`));
    expect(error).toBeNull();
    expect(data).toMatchObject({ inserted: true });
    const rfq = await adminClient().from("rfqs").select("*").eq("id", data.rfq_id).single();
    expect(rfq.data).toMatchObject({ organization_id: world.tenants.alpha.id, customer: "Pat Buyer", email: "buyer@example.test", status: "new", description: "Brackets x50\nPlease quote 50 brackets" });
    const stored = await adminClient().from("inbound_emails").select("*").eq("id", data.inbound_email_id).single();
    expect(stored.data).toMatchObject({ organization_id: world.tenants.alpha.id, rfq_id: data.rfq_id, from_address: "buyer@example.test" });
  });

  it("uses the address as the customer when the sender has no name", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const { data } = await admin.rpc("record_inbound_email", message(`g-${world.runId}-noname`, { p_from_name: null }));
    const rfq = await adminClient().from("rfqs").select("customer").eq("id", data.rfq_id).single();
    expect(rfq.data?.customer).toBe("buyer@example.test");
  });

  it("repeating the same message stores nothing new and makes no second RFQ", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const id = `g-${world.runId}-dup`;
    const first = await admin.rpc("record_inbound_email", message(id));
    const again = await Promise.all([admin.rpc("record_inbound_email", message(id)), admin.rpc("record_inbound_email", message(id))]);
    expect(first.data.inserted).toBe(true);
    for (const r of again) {
      expect(r.error).toBeNull();
      expect(r.data).toEqual({ inserted: false, inbound_email_id: null, rfq_id: null });
    }
    const rows = await adminClient().from("inbound_emails").select("id").eq("organization_id", world.tenants.alpha.id).eq("graph_message_id", id);
    expect(rows.data).toHaveLength(1);
    const rfqs = await adminClient().from("rfqs").select("id").eq("organization_id", world.tenants.alpha.id).eq("description", "Brackets x50\nPlease quote 50 brackets");
    expect(rfqs.data!.filter((r) => r.id === first.data.rfq_id)).toHaveLength(1);
  });

  it("the same Graph id in another company is a different message", async () => {
    const id = `g-${world.runId}-shared`;
    const a = await (await signedInClient(world.tenants.alpha.users.admin)).rpc("record_inbound_email", message(id));
    const b = await (await signedInClient(world.tenants.beta.users.admin)).rpc("record_inbound_email", message(id));
    expect(a.data.inserted).toBe(true);
    expect(b.data.inserted).toBe(true);
  });

  it.each(["office", "workshop", "viewer"] as const)("is refused for %s", async (role) => {
    const client = await signedInClient(world.tenants.alpha.users[role]);
    const { error } = await client.rpc("record_inbound_email", message(`g-${world.runId}-${role}`));
    expect(error?.code).toBe("42501");
  });

  it("is not available without signing in", async () => {
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    const { error } = await anon.rpc("record_inbound_email", message(`g-${world.runId}-anon`));
    expect(error).not.toBeNull();
  });
});

describe("reading inbound_emails (RLS)", () => {
  it("admin and office of the company can read it; workshop and viewer see nothing", async () => {
    const own = await adminClient().from("inbound_emails").select("id").eq("organization_id", world.tenants.alpha.id);
    expect(own.data!.length).toBeGreaterThan(0);
    for (const role of ["admin", "office"] as const) {
      const { data, error } = await (await signedInClient(world.tenants.alpha.users[role])).from("inbound_emails").select("id");
      expect(error).toBeNull();
      expect(data!.map((r) => r.id).sort()).toEqual(own.data!.map((r) => r.id).sort());
    }
    for (const role of ["workshop", "viewer"] as const) {
      const { data, error } = await (await signedInClient(world.tenants.alpha.users[role])).from("inbound_emails").select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it("another company can't read it", async () => {
    const alphaIds = (await adminClient().from("inbound_emails").select("id").eq("organization_id", world.tenants.alpha.id)).data!.map((r) => r.id);
    for (const role of ["admin", "office"] as const) {
      const { data } = await (await signedInClient(world.tenants.beta.users[role])).from("inbound_emails").select("id");
      expect(data!.filter((r) => alphaIds.includes(r.id))).toEqual([]);
    }
  });

  it("no signed-in role can insert, update or delete rows directly", async () => {
    const [row] = (await adminClient().from("inbound_emails").select("id").eq("organization_id", world.tenants.alpha.id).limit(1)).data!;
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const insert = await admin.from("inbound_emails").insert({ organization_id: world.tenants.alpha.id, graph_message_id: `direct-${world.runId}`, received_at: "2026-02-03T09:00:00Z" });
    expect(insert.error).not.toBeNull();
    const update = await admin.from("inbound_emails").update({ subject: "changed" }).eq("id", row.id).select("id");
    expect(update.error ?? update.data).not.toEqual([{ id: row.id }]);
    const del = await admin.from("inbound_emails").delete().eq("id", row.id).select("id");
    expect(del.error ?? del.data).not.toEqual([{ id: row.id }]);
    expect((await adminClient().from("inbound_emails").select("subject").eq("id", row.id).single()).data?.subject).toBe("Brackets x50");
  });

  it("deleting the RFQ keeps the stored message (rfq_id is cleared)", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const { data } = await admin.rpc("record_inbound_email", message(`g-${world.runId}-rfqgone`));
    await adminClient().from("rfqs").delete().eq("id", data.rfq_id);
    const stored = await adminClient().from("inbound_emails").select("rfq_id").eq("id", data.inbound_email_id).single();
    expect(stored.data?.rfq_id).toBeNull();
  });
});
