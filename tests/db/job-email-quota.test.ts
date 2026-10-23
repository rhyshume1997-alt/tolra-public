/**
 * Job e-mail limits (audit B7a: SEC4; migration 025). The check and the reservation are one transaction, so parallel
 * requests can't all pass the same count; the count lives in a ledger that editing or deleting the visible history
 * doesn't reset; and repeating a request key never makes a second attempt, except a retry after a definite refusal, which is
 * recorded and charged as an attempt of its own (migration 033).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const jobs: Record<"alpha" | "beta", string> = { alpha: "", beta: "" };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const t of ["alpha", "beta"] as const) {
    const { data, error } = await adminClient().from("jobs").insert({ organization_id: world.tenants[t].id, job_no: `J-MAIL-${t}-${world.runId}`, customer: "Mail Co" }).select("id").single();
    expect(error).toBeNull();
    jobs[t] = data!.id;
  }
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const reserve = (client: SupabaseClient, job: string, opts: { key?: string; to?: string; mode?: string } = {}) =>
  client.rpc("reserve_job_email", {
    p_job: job,
    p_recipient: opts.to ?? "buyer@example.test",
    p_subject: "Job sheet",
    p_body: "Synthetic.",
    p_key: opts.key ?? randomUUID(),
    p_mode: opts.mode ?? "sending",
  });

const ledgerCount = (userId: string) =>
  withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.email_send_ledger where user_id = $1", [userId])).rows[0].n as number);

/** The latest attempt's ledger outcome and the visible history's status for one e-mail. */
const statusOf = (history: string) => withDb(async (db) => (await db.query("select l.status as ledger, h.status as history from security_audit.email_send_ledger l join public.email_history h on h.id = l.history_id where l.history_id = $1 order by l.attempt desc limit 1", [history])).rows[0]);

describe("per-person limit", () => {
  it("fifteen parallel requests: exactly ten are reserved, five refused with 429", async () => {
    const office = await signedInClient(world.tenants.alpha.users.office);
    const results = await Promise.all(Array.from({ length: 15 }, () => reserve(office, jobs.alpha)));
    expect(results.filter((r) => !r.error)).toHaveLength(10);
    const refused = results.filter((r) => r.error);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(r.error).toMatchObject({ code: "PT429", hint: "user" });
    expect(await ledgerCount(world.tenants.alpha.users.office.id)).toBe(10);
  });

  it("deleting and editing the visible history doesn't give the quota back", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const officeId = world.tenants.alpha.users.office.id;
    const removed = await admin.from("email_history").delete().eq("drafted_by", officeId).select("id");
    expect(removed.error).toBeNull();
    expect(removed.data!.length).toBe(10);
    const office = await signedInClient(world.tenants.alpha.users.office);
    expect((await reserve(office, jobs.alpha)).error).toMatchObject({ code: "PT429" });
    expect(await ledgerCount(officeId)).toBe(10);
  });
});

describe("request keys", () => {
  it("the same key returns the first attempt; no second history row or quota", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const key = randomUUID();
    const first = await reserve(admin, jobs.alpha, { key });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ replay: false, status: "sending" });
    const again = await reserve(admin, jobs.alpha, { key });
    expect(again.data).toEqual({ history_id: first.data.history_id, replay: true, status: "sending" });
    const { count } = await adminClient().from("email_history").select("*", { count: "exact", head: true }).eq("drafted_by", world.tenants.alpha.users.admin.id);
    expect(count).toBe(1);
    expect(await ledgerCount(world.tenants.alpha.users.admin.id)).toBe(1);
  });

  it("a sent e-mail replays as sent; a failed one may be retried under its key, as a new attempt that is charged", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const sentKey = randomUUID();
    const sent = await reserve(admin, jobs.alpha, { key: sentKey });
    expect((await admin.rpc("complete_job_email", { p_history: sent.data.history_id, p_outcome: "accepted" })).error).toBeNull();
    expect((await reserve(admin, jobs.alpha, { key: sentKey })).data).toMatchObject({ replay: true, status: "sent_via_system" });

    const failedKey = randomUUID();
    const failed = await reserve(admin, jobs.alpha, { key: failedKey });
    expect((await admin.rpc("complete_job_email", { p_history: failed.data.history_id, p_outcome: "failed" })).error).toBeNull();
    const before = await ledgerCount(world.tenants.alpha.users.admin.id);
    expect((await reserve(admin, jobs.alpha, { key: failedKey })).data).toEqual({ history_id: failed.data.history_id, replay: false, status: "sending" });
    expect(await ledgerCount(world.tenants.alpha.users.admin.id)).toBe(before + 1);
  });

  it("a key can't be reused for a different recipient", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const key = randomUUID();
    expect((await reserve(admin, jobs.alpha, { key })).error).toBeNull();
    expect((await reserve(admin, jobs.alpha, { key, to: "other@example.test" })).error).toMatchObject({ code: "PT409" });
  });
});

describe("outcomes (migration 033): a definite refusal may be retried; an unknown outcome never is", () => {

  it("unknown: a repeat of the key is not sent again and makes no new history or quota", async () => {
    const office = await signedInClient(world.tenants.beta.users.office);
    const key = randomUUID();
    const first = await reserve(office, jobs.beta, { key });
    expect(first.error).toBeNull();
    expect((await office.rpc("complete_job_email", { p_history: first.data.history_id, p_outcome: "unknown" })).error).toBeNull();
    expect(await statusOf(first.data.history_id)).toEqual({ ledger: "unknown", history: "unknown" });
    const before = await ledgerCount(world.tenants.beta.users.office.id);
    const again = await reserve(office, jobs.beta, { key });
    expect(again.data).toEqual({ history_id: first.data.history_id, replay: true, status: "unknown" });
    expect(await ledgerCount(world.tenants.beta.users.office.id)).toBe(before);
    // Once the outcome is recorded the sender can't complete it again.
    expect((await office.rpc("complete_job_email", { p_history: first.data.history_id, p_outcome: "accepted" })).error).toMatchObject({ code: "42501" });
  });

  it("a reservation still 'sending' after 10 minutes is treated as unknown, not failed; a fresh one is left alone", async () => {
    const office = await signedInClient(world.tenants.beta.users.office);
    const key = randomUUID();
    const first = await reserve(office, jobs.beta, { key });
    await withDb((db) => db.query("update security_audit.email_send_ledger set updated_at = now() - interval '11 minutes' where history_id = $1", [first.data.history_id]));
    const fresh = await reserve(office, jobs.beta);
    expect((await reserve(office, jobs.beta, { key })).data).toEqual({ history_id: first.data.history_id, replay: true, status: "unknown" });
    expect(await statusOf(first.data.history_id)).toEqual({ ledger: "unknown", history: "unknown" });
    expect((await statusOf(fresh.data.history_id)).ledger).toBe("sending");
  });

  it("only an admin of the same company settles it: sent stays sent, failed may be tried again", async () => {
    const office = await signedInClient(world.tenants.beta.users.office);
    const betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    const alphaAdmin = await signedInClient(world.tenants.alpha.users.admin);
    const unknown = async () => {
      const key = randomUUID();
      const first = await reserve(office, jobs.beta, { key });
      await office.rpc("complete_job_email", { p_history: first.data.history_id, p_outcome: "unknown" });
      return { key, history: first.data.history_id as string };
    };

    const one = await unknown();
    expect((await office.rpc("resolve_job_email", { p_history: one.history, p_as: "sent" })).error).toMatchObject({ code: "42501" });
    expect((await alphaAdmin.rpc("resolve_job_email", { p_history: one.history, p_as: "sent" })).error).toMatchObject({ code: "P0002" });
    expect((await betaAdmin.rpc("resolve_job_email", { p_history: one.history, p_as: "maybe" })).error).toMatchObject({ code: "22023" });
    expect((await betaAdmin.rpc("resolve_job_email", { p_history: one.history, p_as: "sent" })).error).toBeNull();
    expect(await statusOf(one.history)).toEqual({ ledger: "confirmed_sent", history: "sent_via_system" });
    expect((await reserve(office, jobs.beta, { key: one.key })).data).toMatchObject({ replay: true, status: "sent_via_system" });
    expect((await betaAdmin.rpc("resolve_job_email", { p_history: one.history, p_as: "failed" })).error).toMatchObject({ code: "PT409" });

    const two = await unknown();
    expect((await betaAdmin.rpc("resolve_job_email", { p_history: two.history, p_as: "failed" })).error).toBeNull();
    expect(await statusOf(two.history)).toEqual({ ledger: "failed", history: "failed" });
    expect((await reserve(office, jobs.beta, { key: two.key })).data).toEqual({ history_id: two.history, replay: false, status: "sending" });
  });

  it("a fresh send can't be settled, and the ledger can't be edited through the API", async () => {
    const betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    const fresh = await reserve(betaAdmin, jobs.beta);
    expect((await betaAdmin.rpc("resolve_job_email", { p_history: fresh.data.history_id, p_as: "failed" })).error).toMatchObject({ code: "PT409" });
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await expect(db.query("update security_audit.email_send_ledger set status = 'failed'")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.query("rollback");
      }
    });
  });
});

describe("each retry of a failed send is its own attempt, charged against the limits (migration 033)", () => {
  let w2: SyntheticWorld;
  let job: string;
  beforeAll(async () => {
    w2 = await createSyntheticWorld();
    job = (await adminClient().from("jobs").insert({ organization_id: w2.tenants.alpha.id, job_no: `J-RETRY-${w2.runId}`, customer: "Retry Co" }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    if (w2) await destroySyntheticWorld(w2.runId);
  });

  const HOURLY = { code: "PT429", hint: "user", message: "Rate limit exceeded. Max 10 emails per hour." };
  const DAILY = { code: "PT429", hint: "organization", message: "Daily email limit reached for your organisation." };

  /** A send that failed `ago` ago: its key, history and ledger row, as the owner. */
  const failedSend = (user: string, ago: string) => withDb(async (db) => {
    const k = randomUUID();
    const h = (await db.query("insert into public.email_history (organization_id, to_email, subject, body, related_to_type, related_to_id, drafted_by, status) values ($1, 'buyer@example.test', 'S', 'B', 'job', $2, $3, 'failed') returning id", [w2.tenants.alpha.id, job, user])).rows[0].id as string;
    await db.query("insert into security_audit.email_send_ledger (organization_id, user_id, job_id, recipient, idempotency_key, history_id, status, created_at, updated_at) values ($1, $2, $3, 'buyer@example.test', $4, $5, 'failed', now() - $6::interval, now() - $6::interval)", [w2.tenants.alpha.id, user, job, k, h, ago]);
    return { key: k, history: h };
  });
  /** Every ledger row for one e-mail, first attempt first. `linked`: the row points at the first attempt (retries only). */
  const attempts = (history: string) => withDb(async (db) => (await db.query(
    `select l.attempt, l.status, l.created_at > now() - interval '1 minute' as dated_now,
            coalesce(l.retry_of = (select f.id from security_audit.email_send_ledger f where f.history_id = l.history_id and f.attempt = 1), false) as linked
     from security_audit.email_send_ledger l where l.history_id = $1 order by l.attempt`, [history])).rows);
  const countFor = (user: string) => withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.email_send_ledger where user_id = $1 and created_at > now() - interval '1 hour'", [user])).rows[0].n as number);
  const fill = (user: string, n: number, ago = "0 minutes") => withDb((db) => db.query(
    `insert into security_audit.email_send_ledger (organization_id, user_id, job_id, recipient, idempotency_key, history_id, status, created_at)
     select $1, $2, $3, 'buyer@example.test', 'fill-' || gen_random_uuid(), gen_random_uuid(), 'accepted', now() - $5::interval from generate_series(1, $4)`,
    [w2.tenants.alpha.id, user, job, n, ago]));

  it("yesterday's failure retried today uses today's allowance as a new attempt; the failure keeps its outcome and date", async () => {
    const admin = w2.tenants.alpha.users.admin;
    const client = await signedInClient(admin);
    const old = await failedSend(admin.id, "2 days");
    expect(await countFor(admin.id)).toBe(0);
    const retried = await reserve(client, job, { key: old.key });
    expect(retried.data).toEqual({ history_id: old.history, replay: false, status: "sending" });
    expect(await countFor(admin.id)).toBe(1); // now counted in the last hour
    expect(await attempts(old.history)).toEqual([
      { attempt: 1, status: "failed", dated_now: false, linked: false },
      { attempt: 2, status: "sending", dated_now: true, linked: true },
    ]);
  });

  it("and is refused when today's per-person limit is already used: nothing about the old failure changes", async () => {
    const office = w2.tenants.alpha.users.office;
    const client = await signedInClient(office);
    const old = await failedSend(office.id, "2 days");
    await fill(office.id, 10);
    const refused = await reserve(client, job, { key: old.key });
    expect(refused.error).toMatchObject(HOURLY);
    expect(await attempts(old.history)).toEqual([{ attempt: 1, status: "failed", dated_now: false, linked: false }]);
    expect(await countFor(office.id)).toBe(10);
    // The first hour passing frees it; the same retry then works and is charged.
    await withDb((db) => db.query("update security_audit.email_send_ledger set created_at = now() - interval '2 hours' where user_id = $1 and idempotency_key like 'fill-%'", [office.id]));
    expect((await reserve(client, job, { key: old.key })).data).toMatchObject({ replay: false, status: "sending" });
    expect(await countFor(office.id)).toBe(1);
  });

  it("and is refused when the company's limit for the day is used", async () => {
    const admin = w2.tenants.alpha.users.admin;
    const client = await signedInClient(admin);
    const old = await failedSend(admin.id, "2 days");
    // The company has had its 100 today (from people other than the one retrying, a few hours ago so the hourly limit is clear).
    const count = (await withDb((db) => db.query("select count(*)::int as n from security_audit.email_send_ledger where organization_id = $1 and created_at > now() - interval '1 day'", [w2.tenants.alpha.id]))).rows[0].n as number;
    await fill(w2.tenants.alpha.users.workshop.id, 100 - count, "5 hours");
    const refused = await reserve(client, job, { key: old.key });
    expect(refused.error).toMatchObject(DAILY);
    expect(await attempts(old.history)).toEqual([{ attempt: 1, status: "failed", dated_now: false, linked: false }]);
  });

  it("repeated failed retries each use an allowance: they run out the hour's and are then refused with 429; every attempt is kept", async () => {
    const admin = w2.tenants.beta.users.admin;
    const client = await signedInClient(admin);
    const betaJob = (await adminClient().from("jobs").insert({ organization_id: w2.tenants.beta.id, job_no: `J-R2-${w2.runId}`, customer: "R" }).select("id").single()).data!.id as string;
    const key = randomUUID();
    expect(await countFor(admin.id)).toBe(0);
    const first = await reserve(client, betaJob, { key });
    expect(first.error).toBeNull();
    const history = first.data.history_id as string;
    expect((await client.rpc("complete_job_email", { p_history: history, p_outcome: "failed" })).error).toBeNull();
    // Nine retries, each refused by the provider: ten attempts in all, ten of the hour's ten.
    for (let n = 2; n <= 10; n += 1) {
      const retry = await reserve(client, betaJob, { key });
      expect({ n, error: retry.error, data: retry.data }).toEqual({ n, error: null, data: { history_id: history, replay: false, status: "sending" } });
      expect(await countFor(admin.id)).toBe(n);
      expect((await client.rpc("complete_job_email", { p_history: history, p_outcome: "failed" })).error).toBeNull();
    }
    // The next retry finds the allowance used: refused, and nothing is recorded or changed.
    const refused = await reserve(client, betaJob, { key });
    expect(refused.error).toMatchObject(HOURLY);
    expect(await countFor(admin.id)).toBe(10);
    const rows = await attempts(history);
    expect(rows).toEqual(Array.from({ length: 10 }, (_, i) => ({ attempt: i + 1, status: "failed", dated_now: true, linked: i > 0 })));
    expect(await statusOf(history)).toEqual({ ledger: "failed", history: "failed" });
  });
});

describe("company limit and access", () => {
  it("the 101st e-mail of the day for a company is refused", async () => {
    const beta = world.tenants.beta;
    await withDb((db) => db.query(
      `insert into security_audit.email_send_ledger (organization_id, user_id, job_id, recipient, idempotency_key, history_id, status)
       select $1, $2, $3, 'buyer@example.test', 'seeded-' || g, gen_random_uuid(), 'accepted'
       from generate_series(1, 99 - (select count(*)::int from security_audit.email_send_ledger where organization_id = $1)) g`,
      [beta.id, beta.users.office.id, jobs.beta],
    ));
    const admin = await signedInClient(beta.users.admin);
    expect((await reserve(admin, jobs.beta)).error).toBeNull();
    expect((await reserve(admin, jobs.beta)).error).toMatchObject({ code: "PT429", hint: "organization" });
  });

  it("workshop and viewer can't reserve; another company's job isn't found", async () => {
    for (const role of ["workshop", "viewer"] as const) {
      const client = await signedInClient(world.tenants.alpha.users[role]);
      expect((await reserve(client, jobs.alpha)).error).toMatchObject({ code: "42501" });
    }
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    expect((await reserve(admin, jobs.beta)).error).toMatchObject({ code: "P0002" });
  });

  it("the ledger can't be read or changed through the API, even with the service key", async () => {
    const service = adminClient();
    const read = await service.schema("security_audit").from("email_send_ledger").select("id").limit(1);
    expect(read.error).not.toBeNull();
    const asApi = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        return await db.query("update security_audit.email_send_ledger set recipient = 'x'").then(() => "changed", (e) => e.code);
      } finally {
        await db.query("rollback");
      }
    });
    expect(asApi).toBe("42501");
  });
});
