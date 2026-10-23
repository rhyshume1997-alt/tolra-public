/**
 * Mailbox send accounting (migration 031): reservation is atomic under a lock, kept in a ledger the API roles can't reach,
 * and an uncertain outcome blocks a repeat until an admin settles it. Same rules as the job e-mail ledger (025).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const key = () => randomBytes(32).toString("hex");
const reserve = (client: SupabaseClient, k = key(), kind = "send") =>
  client.rpc("reserve_mail_send", { p_kind: kind, p_key: k, p_recipients: ["buyer@example.test"], p_subject: "Quote", p_body: "Synthetic.", p_rfq: null });
const ledger = (userId: string) => withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.mail_send_ledger where user_id = $1", [userId])).rows[0].n as number);

describe("hourly limit", () => {
  it("thirty parallel reservations: exactly twenty are made, ten refused with 429", async () => {
    const admin = await signedInClient(world.tenants.beta.users.admin);
    const results = await Promise.all(Array.from({ length: 30 }, () => reserve(admin)));
    expect(results.filter((r) => !r.error)).toHaveLength(20);
    const refused = results.filter((r) => r.error);
    expect(refused).toHaveLength(10);
    for (const r of refused) expect(r.error).toMatchObject({ code: "PT429" });
    expect(await ledger(world.tenants.beta.users.admin.id)).toBe(20);
  });

  it("deleting or editing the visible history doesn't give the quota back", async () => {
    const admin = await signedInClient(world.tenants.beta.users.admin);
    const history = await admin.from("email_history").select("id").eq("drafted_by", world.tenants.beta.users.admin.id);
    expect(history.data!.length).toBeGreaterThanOrEqual(20);
    expect((await admin.from("email_history").update({ status: "failed" }).eq("drafted_by", world.tenants.beta.users.admin.id)).error).toBeNull();
    expect((await admin.from("email_history").delete().eq("drafted_by", world.tenants.beta.users.admin.id)).error).toBeNull();
    expect((await reserve(admin)).error).toMatchObject({ code: "PT429" });
    expect(await ledger(world.tenants.beta.users.admin.id)).toBe(20);
  });

  it("the API roles can't read, write or delete the ledger", async () => {
    const admin = await signedInClient(world.tenants.beta.users.admin);
    for (const [name, sql] of [["select", "select * from security_audit.mail_send_ledger"], ["update", "update security_audit.mail_send_ledger set status = 'failed'"], ["delete", "delete from security_audit.mail_send_ledger"], ["insert", "insert into security_audit.mail_send_ledger (organization_id, user_id, kind, idempotency_key, recipients, history_id, status) values (gen_random_uuid(), gen_random_uuid(), 'send', repeat('a', 64), '{}', gen_random_uuid(), 'sending')"]] as const) {
      await withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query("set local role authenticated");
          await expect(db.query(sql), name).rejects.toMatchObject({ code: "42501" });
        } finally {
          await db.query("rollback");
        }
      });
    }
    // And not through the REST API either.
    const viaRest = await admin.schema("security_audit" as never).from("mail_send_ledger").select("id");
    expect(viaRest.error).not.toBeNull();
  });
});

describe("keys and outcomes", () => {
  it("a key that is sending, accepted or unknown is refused (409); failed may be retried without using more quota", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const id = world.tenants.alpha.users.admin.id;
    const k = key();
    const first = await reserve(admin, k);
    expect(first.error).toBeNull();
    const sendId = first.data.send_id as string;
    expect((await reserve(admin, k)).error).toMatchObject({ code: "PT409" }); // sending

    expect((await admin.rpc("complete_mail_send", { p_id: sendId, p_outcome: "unknown" })).error).toBeNull();
    expect((await reserve(admin, k)).error).toMatchObject({ code: "PT409" }); // unknown
    expect((await admin.rpc("complete_mail_send", { p_id: sendId, p_outcome: "failed" })).error).not.toBeNull(); // no longer 'sending'

    expect((await admin.rpc("resolve_mail_send", { p_id: sendId, p_as: "failed" })).error).toBeNull();
    const before = await ledger(id);
    const retry = await reserve(admin, k); // failed
    expect(retry.error).toBeNull();
    expect(retry.data.send_id).toBe(sendId);
    expect(await ledger(id)).toBe(before);

    expect((await admin.rpc("complete_mail_send", { p_id: sendId, p_outcome: "accepted" })).error).toBeNull();
    expect((await reserve(admin, k)).error).toMatchObject({ code: "PT409" }); // accepted
    const history = await adminClient().from("email_history").select("status, sent_at, to_email").eq("id", retry.data.history_id).single();
    expect(history.data).toMatchObject({ status: "sent_via_system", to_email: "buyer@example.test" });
    expect(history.data!.sent_at).not.toBeNull();
  });

  it("a failed send is marked failed in the history and may be tried again", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const k = key();
    const first = await reserve(admin, k);
    await admin.rpc("complete_mail_send", { p_id: first.data.send_id, p_outcome: "failed" });
    expect((await adminClient().from("email_history").select("status").eq("id", first.data.history_id).single()).data?.status).toBe("failed");
    expect((await reserve(admin, k)).error).toBeNull();
    expect((await adminClient().from("email_history").select("status").eq("id", first.data.history_id).single()).data?.status).toBe("sending");
  });

  it("an unknown outcome stays 'sending' in the history until an admin settles it; 'sent' keeps blocking repeats", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const k = key();
    const first = await reserve(admin, k);
    await admin.rpc("complete_mail_send", { p_id: first.data.send_id, p_outcome: "unknown" });
    expect((await adminClient().from("email_history").select("status").eq("id", first.data.history_id).single()).data?.status).toBe("sending");
    expect((await admin.rpc("resolve_mail_send", { p_id: first.data.send_id, p_as: "sent" })).error).toBeNull();
    expect((await adminClient().from("email_history").select("status").eq("id", first.data.history_id).single()).data?.status).toBe("sent_via_system");
    expect((await reserve(admin, k)).error).toMatchObject({ code: "PT409" });
    // Only an unknown outcome can be resolved.
    expect((await admin.rpc("resolve_mail_send", { p_id: first.data.send_id, p_as: "failed" })).error).toMatchObject({ code: "PT409" });
  });

  it("the history records every effective recipient", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const r = await admin.rpc("reserve_mail_send", { p_kind: "reply", p_key: key(), p_recipients: ["a@example.test", "b@example.test"], p_subject: "Re: Quote", p_body: "x", p_rfq: null });
    expect((await adminClient().from("email_history").select("to_email").eq("id", r.data.history_id).single()).data?.to_email).toBe("a@example.test, b@example.test");
  });
});

describe("who may reserve and settle", () => {
  it.each(["office", "workshop", "viewer"] as const)("%s can't reserve, complete or resolve", async (role) => {
    const client = await signedInClient(world.tenants.alpha.users[role]);
    expect((await reserve(client)).error).toMatchObject({ code: "42501" });
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const r = await reserve(admin);
    expect((await client.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "accepted" })).error).toMatchObject({ code: "42501" });
    expect((await client.rpc("resolve_mail_send", { p_id: r.data.send_id, p_as: "sent" })).error).toMatchObject({ code: "42501" });
  });

  it("another company's admin can't complete or resolve it", async () => {
    const mine = await signedInClient(world.tenants.alpha.users.admin);
    const other = await signedInClient(world.tenants.beta.users.admin);
    const r = await reserve(mine);
    expect((await other.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "accepted" })).error).toMatchObject({ code: "42501" });
    await mine.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "unknown" });
    expect((await other.rpc("resolve_mail_send", { p_id: r.data.send_id, p_as: "failed" })).error).toMatchObject({ code: "P0002" });
  });

  it("the same key in another company is a different send", async () => {
    const k = key();
    expect((await reserve(await signedInClient(world.tenants.alpha.users.admin), k)).error).toBeNull();
    expect((await reserve(await signedInClient(world.tenants.beta.users.admin), k)).error).not.toMatchObject({ code: "PT409" });
  });
});

// ---- interrupted sends, retry ownership and hourly accounting -------------------------------------------------------

const ledgerRow = (id: string) => withDb(async (db) => (await db.query("select status, user_id, created_at from security_audit.mail_send_ledger where id = $1", [id])).rows[0] as { status: string; user_id: string; created_at: Date });
const age = (id: string, column: "updated_at" | "created_at", interval: string) =>
  withDb((db) => db.query(`update security_audit.mail_send_ledger set ${column} = now() - $2::interval where id = $1`, [id, interval]));
const inLastHour = (userId: string) =>
  withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.mail_send_ledger where user_id = $1 and created_at > now() - interval '1 hour'", [userId])).rows[0].n as number);

/** Another admin of the same company. */
async function extraAdmin(tenant: "alpha" | "beta", name: string) {
  const email = `${name}.${tenant}.${world.runId}@example.test`;
  const password = randomBytes(12).toString("hex");
  const admin = adminClient();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const added = await admin.rpc("add_member", { p_org: world.tenants[tenant].id, p_email: email, p_role: "admin" });
  expect(added.error).toBeNull();
  return { id: created.data.user!.id, client: await signedInClient({ email, password }) };
}

describe("interrupted sends (a reservation that never got its outcome)", () => {
  it("a fresh 'sending' reservation is active: it can't be resolved and its key stays refused", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const k = key();
    const r = await reserve(admin, k);
    expect((await admin.rpc("resolve_mail_send", { p_id: r.data.send_id, p_as: "failed" })).error).toMatchObject({ code: "PT409" });
    expect((await reserve(admin, k)).error).toMatchObject({ code: "PT409" });
    await age(r.data.send_id, "updated_at", "9 minutes");
    expect((await admin.rpc("resolve_mail_send", { p_id: r.data.send_id, p_as: "failed" })).error).toMatchObject({ code: "PT409" });
    expect((await ledgerRow(r.data.send_id)).status).toBe("sending");
    expect((await admin.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "accepted" })).error).toBeNull(); // the live request can still finish
  });

  it("a stale 'sending' becomes resolvable as unknown", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const r = await reserve(admin);
    await age(r.data.send_id, "updated_at", "11 minutes");
    const resolved = await admin.rpc("resolve_mail_send", { p_id: r.data.send_id, p_as: "sent" });
    expect(resolved.error).toBeNull();
    expect(resolved.data).toBe(r.data.history_id); // the e-mail history id, for the audit entry
    expect((await ledgerRow(r.data.send_id)).status).toBe("confirmed_sent");
    expect((await adminClient().from("email_history").select("status").eq("id", r.data.history_id).single()).data?.status).toBe("sent_via_system");
  });

  it("a repeat of a stale key is still refused (409) and nothing retries on its own, until an admin resolves it", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const k = key();
    const r = await reserve(admin, k);
    const rowsBefore = await ledger(world.tenants.alpha.users.admin.id);
    await age(r.data.send_id, "updated_at", "11 minutes");
    expect((await reserve(admin, k)).error).toMatchObject({ code: "PT409" });
    expect(["sending", "unknown"]).toContain((await ledgerRow(r.data.send_id)).status); // a refusal rolls back, so it may still read 'sending'; never 'failed'
    expect((await reserve(admin, k)).error).toMatchObject({ code: "PT409" });
    expect(await ledger(world.tenants.alpha.users.admin.id)).toBe(rowsBefore);
    // Any later successful reservation by the company records it as unknown.
    expect((await reserve(admin)).error).toBeNull();
    expect((await ledgerRow(r.data.send_id)).status).toBe("unknown");
    // Too late for the original request to claim it.
    expect((await admin.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "accepted" })).error).toMatchObject({ code: "42501" });
    expect((await admin.rpc("resolve_mail_send", { p_id: r.data.send_id, p_as: "failed" })).error).toBeNull();
    expect((await reserve(admin, k)).error).toBeNull();
  });

  it("the API roles can't expire reservations themselves", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    expect((await admin.rpc("expire_stale_mail_sends")).error).not.toBeNull();
  });
});

describe("retrying a failed send", () => {
  it("a different admin of the company can retry it and complete it; the row becomes theirs, dated now", async () => {
    const first = await signedInClient(world.tenants.alpha.users.admin);
    const second = await extraAdmin("alpha", "retry");
    const k = key();
    const r = await reserve(first, k);
    await first.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "failed" });
    await age(r.data.send_id, "created_at", "30 minutes");
    const retry = await reserve(second.client, k);
    expect(retry.error).toBeNull();
    expect(retry.data.send_id).toBe(r.data.send_id);
    const row = await ledgerRow(r.data.send_id);
    expect(row.user_id).toBe(second.id);
    expect(Date.now() - row.created_at.getTime()).toBeLessThan(60_000);
    expect((await first.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "accepted" })).error).toMatchObject({ code: "42501" });
    expect((await second.client.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "accepted" })).error).toBeNull();
    expect((await adminClient().from("email_history").select("drafted_by, status").eq("id", retry.data.history_id).single()).data).toMatchObject({ drafted_by: second.id, status: "sent_via_system" });
  });

  it("is refused (429) when the retrying admin is at the hourly limit", async () => {
    const first = await signedInClient(world.tenants.alpha.users.admin);
    const busy = await extraAdmin("alpha", "busy");
    const k = key();
    const r = await reserve(first, k);
    await first.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "failed" });
    const fill = await Promise.all(Array.from({ length: 20 }, () => reserve(busy.client)));
    expect(fill.filter((x) => !x.error)).toHaveLength(20);
    expect((await reserve(busy.client, k)).error).toMatchObject({ code: "PT429" });
    expect((await ledgerRow(r.data.send_id)).status).toBe("failed"); // untouched
  });

  it("a failed reservation from over an hour ago counts in the current hour once retried", async () => {
    const first = await signedInClient(world.tenants.alpha.users.admin);
    const second = await extraAdmin("alpha", "late");
    const k = key();
    const r = await reserve(first, k);
    await first.rpc("complete_mail_send", { p_id: r.data.send_id, p_outcome: "failed" });
    await age(r.data.send_id, "created_at", "2 hours");
    const before = await inLastHour(second.id);
    expect((await reserve(second.client, k)).error).toBeNull();
    expect(await inLastHour(second.id)).toBe(before + 1);
    // Retrying by the same person in the same hour is still one place, not two.
    const k2 = key();
    const r2 = await reserve(second.client, k2);
    await second.client.rpc("complete_mail_send", { p_id: r2.data.send_id, p_outcome: "failed" });
    const mid = await inLastHour(second.id);
    expect((await reserve(second.client, k2)).error).toBeNull();
    expect(await inLastHour(second.id)).toBe(mid);
  });
});
