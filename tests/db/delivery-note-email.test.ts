/**
 * Delivery note e-mail records (audit B7a: A6, D17; migration 026). History and the note's e-mailed time change
 * together or not at all; copying the text records a copy, not a send; workshop staff can't half-write either.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

let n = 0;
async function newNote(tenant: "alpha" | "beta" = "alpha") {
  n += 1;
  const { data, error } = await adminClient().from("delivery_notes")
    .insert({ organization_id: world.tenants[tenant].id, dn_number: `DN-${world.runId}-${n}`, customer: "Mail Co", status: "pending" })
    .select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

async function state(id: string) {
  const admin = adminClient();
  const { data: note } = await admin.from("delivery_notes").select("emailed_at").eq("id", id).single();
  const { data: history } = await admin.from("email_history").select("status, sent_at").eq("related_to_id", id);
  return { emailed: Boolean(note?.emailed_at), history: (history ?? []).map((h) => ({ status: h.status, sent: Boolean(h.sent_at) })) };
}

const log = (role: "admin" | "office" | "workshop", note: string, status: string, subject: string | null = "Delivery note") =>
  signedInClient(world.tenants.alpha.users[role]).then((c) =>
    c.rpc("log_delivery_note_email", { p_note: note, p_to: "buyer@example.test", p_subject: subject, p_body: "Synthetic.", p_status: status }));

describe("recording a delivery note e-mail", () => {
  it("copying records a copy and doesn't mark the note as e-mailed", async () => {
    const note = await newNote();
    const { data, error } = await log("admin", note, "copied");
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(await state(note)).toEqual({ emailed: false, history: [{ status: "copied", sent: false }] });
  });

  it("a confirmed manual send records both, with the same time", async () => {
    const note = await newNote();
    const { data, error } = await log("office", note, "sent_manually");
    expect(error).toBeNull();
    expect(typeof data).toBe("string");
    expect(await state(note)).toEqual({ emailed: true, history: [{ status: "sent_manually", sent: true }] });
  });

  it("workshop is refused and nothing changes", async () => {
    const note = await newNote();
    const { error } = await log("workshop", note, "sent_manually");
    expect(error).toMatchObject({ code: "42501" });
    expect(await state(note)).toEqual({ emailed: false, history: [] });
  });

  it("if the history can't be written, the note isn't marked either", async () => {
    const note = await newNote();
    const { error } = await log("admin", note, "sent_manually", null);
    expect(error).not.toBeNull();
    expect(await state(note)).toEqual({ emailed: false, history: [] });
  });

  it("another company's note isn't found; unknown statuses are refused", async () => {
    const other = await newNote("beta");
    expect((await log("admin", other, "sent_manually")).error).toMatchObject({ code: "P0002" });
    expect(await state(other)).toEqual({ emailed: false, history: [] });
    expect((await log("admin", await newNote(), "sent_via_system")).error).toMatchObject({ code: "22023" });
  });
});
