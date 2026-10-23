import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb, type SyntheticWorld } from "../support/fixtures";

let world: SyntheticWorld;
beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

async function fixture() {
  return withDb(async (db) => {
    const org = world.tenants.alpha.id;
    const machine = (await db.query("insert into machines (organization_id, name) values ($1, $2) returning id", [org, `Identity ${randomUUID()}`])).rows[0].id;
    const otherMachine = (await db.query("insert into machines (organization_id, name) values ($1, $2) returning id", [org, `Other ${randomUUID()}`])).rows[0].id;
    const job = (await db.query("insert into jobs (organization_id, job_no, customer) values ($1, $2, 'Synthetic') returning id", [org, `J-${randomUUID()}`])).rows[0].id;
    const otherJob = (await db.query("insert into jobs (organization_id, job_no, customer) values ($1, $2, 'Synthetic') returning id", [org, `J-${randomUUID()}`])).rows[0].id;
    const booking = (await db.query("insert into machine_bookings (organization_id, machine_id, job_id, job_no, start_at, estimated_hours) values ($1,$2,$3,'Synthetic',now(),2) returning id", [org, machine, job])).rows[0].id;
    return { org, machine, otherMachine, job, otherJob, booking };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const addRun = (db: Client, f: Fixture) => db.query("insert into machine_runs (organization_id, machine_id, job_id, booking_id, started_at) values ($1,$2,$3,$4,now()) returning id", [f.org, f.machine, f.job, f.booking]);

async function waitForBlocked(db: Client, pid: number) {
  for (let n = 0; n < 100; n += 1) {
    if ((await db.query("select cardinality(pg_blocking_pids($1)) as n", [pid])).rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected the competing statement to wait on the booking row");
}

describe("booking identity stays attached to machine history", () => {
  it("rejects job and machine changes for active AND ended references, but permits notes and timing", async () => {
    const f = await fixture();
    await withDb(async (db) => {
      const run = (await addRun(db, f)).rows[0].id;
      for (const ended of [false, true]) {
        if (ended) await db.query("update machine_runs set ended_at=now(), end_reason='paused' where id=$1", [run]);
        await expect(db.query("update machine_bookings set job_id=$1 where id=$2", [f.otherJob, f.booking])).rejects.toMatchObject({ code: "23514", hint: "booking_has_runs" });
        await expect(db.query("update machine_bookings set machine_id=$1 where id=$2", [f.otherMachine, f.booking])).rejects.toMatchObject({ code: "23514", hint: "booking_has_runs" });
        await db.query("update machine_bookings set notes='Fixture ready', start_at=start_at + interval '1 minute' where id=$1", [f.booking]);
      }
      expect((await db.query("select job_id,machine_id,notes from machine_bookings where id=$1", [f.booking])).rows[0]).toEqual({ job_id: f.job, machine_id: f.machine, notes: "Fixture ready" });
    });
  });

  it("permits reassignment before a run exists and refuses a stale run attachment", async () => {
    const f = await fixture();
    await withDb(async (db) => {
      await db.query("update machine_bookings set job_id=$1 where id=$2", [f.otherJob, f.booking]);
      await expect(addRun(db, f)).rejects.toMatchObject({ code: "23514", hint: "run_booking_mismatch" });
      await addRun(db, { ...f, job: f.otherJob });
    });
  });

  it("a concurrent run winning first blocks reassignment after its commit", async () => {
    const f = await fixture();
    await withDb(async (a) => withDb(async (b) => {
      await b.query("set statement_timeout='10s'");
      const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
      await a.query("begin");
      try {
        await addRun(a, f);
        const change = b.query("update machine_bookings set job_id=$1 where id=$2", [f.otherJob, f.booking]).then(() => null, (e: unknown) => e);
        await waitForBlocked(a, pid);
        await a.query("commit");
        expect(await change).toMatchObject({ code: "23514", hint: "booking_has_runs" });
      } finally { await a.query("rollback"); }
    }));
  });

  it("a concurrent reassignment winning first blocks the stale run after its commit", async () => {
    const f = await fixture();
    await withDb(async (a) => withDb(async (b) => {
      await b.query("set statement_timeout='10s'");
      const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
      await a.query("begin");
      try {
        await a.query("update machine_bookings set job_id=$1 where id=$2", [f.otherJob, f.booking]);
        const run = addRun(b, f).then(() => null, (e: unknown) => e);
        await waitForBlocked(a, pid);
        await a.query("commit");
        expect(await run).toMatchObject({ code: "23514", hint: "run_booking_mismatch" });
      } finally { await a.query("rollback"); }
    }));
  });

  it("reapplies the migration without changing its guards or existing data", async () => {
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/064_booking_run_identity.sql"), "utf8");
    await withDb(async (db) => { await db.query(sql); await db.query(sql); });
    const f = await fixture();
    await withDb(async (db) => {
      await addRun(db, f);
      await expect(db.query("update machine_bookings set job_id=null where id=$1", [f.booking])).rejects.toMatchObject({ hint: "booking_has_runs" });
    });
  });
});
