/**
 * Migration 110: public.log_rfq_clarification logs an RFQ clarification e-mail as sent manually and moves an outstanding RFQ (New
 * or Ready, no quote) to 'clarification' in one transaction, re-checking the caller's company, role and sections inside (SECURITY
 * DEFINER). Another company's RFQ reads as not found and nothing is written. SQL only (as PostgREST runs it), so it also runs
 * against plain PostgreSQL with stand-ins (tests/scripts/sql/110_rfq_clarification.proof.sql is the psql version).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, q, refusal } from "./time-support";

let world: SyntheticWorld;
const user = (role: "admin" | "office" | "workshop" | "viewer", tenant: "alpha" | "beta" = "alpha"): Who => ({ id: world.tenants[tenant].users[role].id });
const CALL = "select public.log_rfq_clarification($1, $2, $3) as r";

/** An RFQ made as the owner (no row-level security). */
async function rfq(tenant: "alpha" | "beta", status: string, email: string | null = "rfq110@example.test") {
  return (await withDb((db) => db.query<{ id: string }>(
    "insert into public.rfqs (organization_id, customer, email, description, status) values ($1, $2, $3, 'Shafts', $4) returning id",
    [world.tenants[tenant].id, `RFQ 110 ${world.runId}`, email, status]))).rows[0].id;
}
const statusOf = async (id: string) => (await withDb((db) => db.query<{ status: string }>("select status from public.rfqs where id = $1", [id]))).rows[0].status;
const historyOf = async (id: string) =>
  (await withDb((db) => db.query<{ status: string; to_email: string; drafted_by: string; organization_id: string; sent_at: string | null }>(
    "select status, to_email, drafted_by, organization_id, sent_at from public.email_history where related_to_type = 'rfq' and related_to_id = $1", [id]))).rows;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (!world) return;
  await withDb(async (db) => {
    await db.query("delete from public.email_history where related_to_type = 'rfq' and related_to_id in (select id::text from public.rfqs where customer = $1)", [`RFQ 110 ${world.runId}`]);
    await db.query("delete from public.quotes where customer = $1", [`RFQ 110 ${world.runId}`]);
    await db.query("delete from public.rfqs where customer = $1", [`RFQ 110 ${world.runId}`]);
  });
  await destroySyntheticWorld(world.runId);
});

describe("110: an RFQ clarification e-mail and the RFQ's status in one step", () => {
  it("logs a New RFQ's e-mail as sent manually and moves it to clarification, returning the row", async () => {
    const id = await rfq("alpha", "new", "  rfq110@example.test ");
    const [{ r }] = await q<{ r: { rfq: { id: string; status: string }; moved: boolean } }>(user("office"), CALL, [id, "Drawing", "Which revision?"]);
    expect(r.moved).toBe(true);
    expect(r.rfq).toMatchObject({ id, status: "clarification" });
    expect(await statusOf(id)).toBe("clarification");
    const history = await historyOf(id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: "sent_manually", to_email: "rfq110@example.test", drafted_by: user("office").id, organization_id: world.tenants.alpha.id });
    expect(history[0].sent_at).not.toBeNull();
  });

  it("never moves an RFQ that has a quote, or one already awaiting clarification (the e-mail is still logged)", async () => {
    const quoted = await rfq("alpha", "ready");
    await withDb((db) => db.query("insert into public.quotes (organization_id, quote_ref, customer, rfq_id) values ($1, $2, $3, $4)",
      [world.tenants.alpha.id, `Q110-${world.runId}`, `RFQ 110 ${world.runId}`, quoted]));
    const waiting = await rfq("alpha", "clarification");
    for (const id of [quoted, waiting]) {
      const [{ r }] = await q<{ r: { moved: boolean } }>(user("office"), CALL, [id, "s", "b"]);
      expect(r.moved).toBe(false);
      expect(await historyOf(id)).toHaveLength(1);
    }
    expect(await statusOf(quoted)).toBe("ready");
  });

  it("refuses another company's RFQ as not found and writes nothing", async () => {
    const theirs = await rfq("beta", "new");
    expect(await refusal(user("office"), CALL, [theirs, "s", "b"])).toMatchObject({ code: "P0002", hint: "rfq_not_found" });
    expect(await refusal(user("admin"), CALL, [theirs, "s", "b"])).toMatchObject({ code: "P0002", hint: "rfq_not_found" });
    expect(await statusOf(theirs)).toBe("new");
    expect(await historyOf(theirs)).toEqual([]);
  });

  it("refuses workshop and viewer, a missing address and a blank subject, writing nothing", async () => {
    const id = await rfq("alpha", "new");
    for (const who of [user("workshop"), user("viewer")]) expect(await refusal(who, CALL, [id, "s", "b"])).toMatchObject({ code: "42501", hint: "rfq_not_allowed" });
    expect(await refusal(user("office"), CALL, [id, "  ", "b"])).toMatchObject({ code: "22023", hint: "rfq_email_subject" });
    const noAddress = await rfq("alpha", "new", null);
    expect(await refusal(user("office"), CALL, [noAddress, "s", "b"])).toMatchObject({ code: "22023", hint: "rfq_no_email" });
    expect([await statusOf(id), await statusOf(noAddress)]).toEqual(["new", "new"]);
    expect([...(await historyOf(id)), ...(await historyOf(noAddress))]).toEqual([]);
  });

  it("anon can't call it", async () => {
    const err = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role anon");
        await db.query("select public.log_rfq_clarification(gen_random_uuid(), 's', 'b')");
        return null;
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await db.query("rollback");
      }
    });
    expect(err).toBe("42501");
  });
});
