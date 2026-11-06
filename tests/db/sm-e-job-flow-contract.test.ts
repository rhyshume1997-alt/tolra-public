/**
 * sm-e (4): the TS job-flow rule (lib/job-flow.ts flowStatusOf / jobStatusOf / isOpenJob / OPEN_JOBS_FILTER / RUNNING_JOBS_FILTER) against the
 * SQL (081 public.flow_status, and the predicates the PostgREST filter strings stand for), over EVERY combination of
 * (stage, started_at, finished_at, inspected_at). Rows are written by the database owner in a transaction that is always rolled back.
 * Also records the one place where the TS action rules and flowStatusOf disagree: stage 'rework' WITH inspected_at set (see the last case).
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { OPEN_JOBS_FILTER, RUNNING_JOBS_FILTER, flowStatusOf, isOpenJob, isPutBack, jobStatusOf, reopenCheck } from "@/lib/job-flow";
import { finishCheck, startCheck } from "@/lib/job-actions";

import { asUser, inTransaction, newActor, newOrg, prepareFixture } from "../support/sm-e-db";

beforeAll(prepareFixture);

const STAGES = [null, "material", "setup", "machining", "inspection", "rework", "complete"] as const;
const T = "2026-10-01T09:00:00Z";
const combos = STAGES.flatMap(stage => [null, T].flatMap(started_at => [null, T].flatMap(finished_at => [null, T].map(inspected_at => ({ stage, started_at, finished_at, inspected_at })))));

describe("sm-e job flow: TS rule and SQL agree", () => {
  it("flowStatusOf = flow_status, and the open / running filters select the jobs jobStatusOf calls open / running, for all 56 combinations", async () => {
    // (A WHERE keeps only rows where the predicate is true, so a NULL stage counts as 'not rework': coalesce(..., false).)
    // The PostgREST filter strings are pinned: a change to either forces this file (and the SQL predicates below) to be re-read.
    expect(OPEN_JOBS_FILTER).toBe("stage.eq.rework,inspected_at.is.null");
    expect(RUNNING_JOBS_FILTER).toBe("stage.eq.rework,and(finished_at.is.null,inspected_at.is.null,started_at.not.is.null)");
    expect(combos).toHaveLength(56);
    await inTransaction(async db => {
      const o = await newOrg(db, "flow");
      const rejected: string[] = [];
      const seen: Array<{ c: (typeof combos)[number]; sql: string; open: boolean; running: boolean }> = [];
      for (const c of combos) {
        await db.query("SAVEPOINT ins");
        try {
          const id = (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,stage,started_at,finished_at,inspected_at) VALUES($1,$2,'Flow Ltd',$3,$4,$5,$6) RETURNING id",
            [o.id, `J-FLOW-${randomUUID().slice(0, 8)}`, c.stage, c.started_at, c.finished_at, c.inspected_at])).rows[0].id;
          const r = (await db.query(
            `SELECT public.flow_status(j) AS flow,
                    coalesce(j.stage = 'rework' OR j.inspected_at IS NULL, false) AS open,
                    coalesce(j.stage = 'rework' OR (j.finished_at IS NULL AND j.inspected_at IS NULL AND j.started_at IS NOT NULL), false) AS running
             FROM public.jobs j WHERE j.id = $1`, [id])).rows[0];
          await db.query("RELEASE SAVEPOINT ins");
          seen.push({ c, sql: r.flow, open: r.open, running: r.running });
        } catch (e) {
          await db.query("ROLLBACK TO SAVEPOINT ins");
          rejected.push(`${JSON.stringify(c)}: ${(e as Error).message}`);
        }
      }
      // Every combination is accepted by the database for its owner (a trigger that started refusing some would show here first).
      expect(rejected).toEqual([]);
      expect(seen).toHaveLength(56);
      for (const { c, sql, open, running } of seen) {
        const label = JSON.stringify(c);
        expect([label, flowStatusOf(c)]).toEqual([label, sql]);
        expect([label, isOpenJob(c)]).toEqual([label, open]);
        expect([label, jobStatusOf(c) === "running"]).toEqual([label, running]);
      }
    });
  });

  it("TEST ONLY unless reachable: stage 'rework' with inspected_at set is in progress for flowStatusOf and the SQL, but not 'in rework' for the action rules", async () => {
    const odd = { stage: "rework", started_at: T, finished_at: T, inspected_at: T };
    // Both sides of the contract say in progress / running / open ...
    expect(flowStatusOf(odd)).toBe("in_progress");
    expect(jobStatusOf(odd)).toBe("running");
    expect(isOpenJob(odd)).toBe(true);
    // ... but isPutBack / isInRework require inspected_at to be empty, so the action rules read it as an inspected job:
    expect(isPutBack(odd)).toBe(false);
    expect(startCheck(odd, { viewer: false })).toMatchObject({ shown: true, enabled: false, reason: "Already inspected" });
    expect(finishCheck(odd, { viewer: false })).toMatchObject({ shown: true, enabled: false, reason: "Already inspected" });
    // and reopen is offered to the office for it (the server's reopen_job refuses a job in stage rework: hint in_rework).
    expect(reopenCheck(odd, { role: "office", me: null })).toEqual({ allowed: true, reason: "" });
    // Reachable by a browser role? No: a rework job has inspected_at cleared by every function that sets it (037), and the guards stop a
    // browser role writing either half. So this divergence is TEST ONLY (only the database owner can write the state).
    await inTransaction(async db => {
      const o = await newOrg(db, "flowodd");
      const office = await newActor(db, o.id, "office");
      const rework = (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,stage,started_at,finished_at) VALUES($1,'J-FLOW-RW','Flow Ltd','rework',$2,$2) RETURNING id", [o.id, T])).rows[0].id;
      const normal = (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,stage,started_at,finished_at) VALUES($1,'J-FLOW-NM','Flow Ltd','inspection',$2,$2) RETURNING id", [o.id, T])).rows[0].id;
      // 1. A browser role cannot move a job INTO rework, or create one there.
      expect((await asUser(db, office, "UPDATE public.jobs SET stage='rework' WHERE id=$1", [normal])).error).toMatchObject({ code: "42501" });
      expect((await asUser(db, office, "INSERT INTO public.jobs(organization_id,job_no,customer,stage) VALUES($1,'J-FLOW-X','Flow Ltd','rework')", [o.id])).error).toMatchObject({ code: "42501" });
      // 2. Nor sign a rework job off by hand: inspected_at written outside the inspection functions is wiped (034), and the stage cannot leave rework.
      await asUser(db, office, "UPDATE public.jobs SET inspected_at=now() WHERE id=$1", [rework]);
      expect((await db.query("SELECT inspected_at, stage FROM public.jobs WHERE id=$1", [rework])).rows[0]).toEqual({ inspected_at: null, stage: "rework" });
      expect((await asUser(db, office, "UPDATE public.jobs SET stage='complete', inspected_at=now() WHERE id=$1", [rework])).error).toMatchObject({ code: "42501" });
    });
  });
});
