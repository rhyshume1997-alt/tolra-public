/**
 * A clock action is recorded only in the company it was made in (migration 090; security audit OFFLINE-ORG). Two tabs share one
 * sign-in session, and switch_organization (036) changes that session's company. Proved in SQL as PostgREST runs it (role
 * authenticated, the JWT claims with one session_id for both "tabs"), so it also runs against plain PostgreSQL with stand-ins:
 *   - the bug: 050's four-argument record_attendance_event (kept for builds before 090) files a clock action made in company A in
 *     company B once another tab has switched the session there;
 *   - 090's record_attendance_event_in_company, with the company the action was made in: refused there (42501, hint wrong_company), nothing recorded in either
 *     company; recorded when the session is in that company, and a replay answers the first result; a missing company is refused;
 *   - it is a definer callable by authenticated and not by anon, and 050's function is unchanged beside it.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const person = () => world.tenants.alpha.users.workshop;
const alpha = () => world.tenants.alpha.id;
const beta = () => world.tenants.beta.id;
/** One sign-in session, shared by both tabs. */
const session = randomUUID();

/** One statement as the person on the shared session (authenticated, aal1), in its own transaction. */
async function asTab<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = [], sessionId = session): Promise<R[]> {
  return withDb(async (db: Client) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: person().id, role: "authenticated", aud: "authenticated", session_id: sessionId, aal: "aal1" })]);
      const rows = (await db.query<R>(text, params)).rows;
      await db.query("commit");
      return rows;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}
async function refusal(text: string, params: unknown[] = []) {
  try {
    await asTab(text, params);
    return null;
  } catch (err) {
    const e = err as { code?: string; hint?: string; message: string };
    return { code: e.code, hint: e.hint, message: e.message };
  }
}
const owner = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows);
const switchTo = (org: string) => asTab("select public.switch_organization($1)", [org]);
const rowsFor = (key: string) => owner<{ organization_id: string }>("select organization_id from public.attendance_events where client_op_id = $1", [key]);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const is090 = async () => (await owner<{ v: boolean }>("select to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)') is not null as v"))[0].v;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  // The person works for both companies (a fitter shared by JNR and Marpet).
  await owner("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, 'workshop', true)", [person().id, beta()]);
  await owner("insert into auth.sessions (id, user_id) values ($1, $2)", [session, person().id]);
});
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

describe("two tabs, one session: tab 2 switches company while tab 1 still holds a clock action made in company A", () => {
  it("the bug (050's four-argument function, kept for builds before 090): the action is filed in company B", async () => {
    await switchTo(alpha());
    const key = randomUUID();
    await switchTo(beta()); // tab 2
    await asTab("select public.record_attendance_event($1, 'in', $2, 'Tab 1')", [key, hoursAgo(2)]); // tab 1, made in alpha
    expect((await rowsFor(key)).map((r) => r.organization_id)).toEqual([beta()]);
  });

  it("090: sent with the company it was made in, it is refused in company B and recorded nowhere", async () => {
    expect(await is090()).toBe(true);
    await switchTo(alpha());
    const key = randomUUID();
    await switchTo(beta());
    const refused = await refusal("select public.record_attendance_event_in_company($1, 'in', $2, 'Tab 1', $3)", [key, hoursAgo(2), alpha()]);
    expect(refused).toMatchObject({ code: "42501", hint: "wrong_company" });
    expect(refused?.message).toBe("This clock action was made in another company than the one you are working in now, so it was not recorded.");
    expect(await rowsFor(key)).toEqual([]);
    // Back in company A (the app sends it again under the same key): recorded there, once; a replay answers the first result.
    await switchTo(alpha());
    const [{ r: first }] = await asTab<{ r: Record<string, unknown> }>("select public.record_attendance_event_in_company($1, 'in', $2, 'Tab 1', $3) as r", [key, hoursAgo(2), alpha()]);
    const [{ r: again }] = await asTab<{ r: Record<string, unknown> }>("select public.record_attendance_event_in_company($1, 'in', $2, 'Tab 1', $3) as r", [key, hoursAgo(1), alpha()]);
    expect(first).toMatchObject({ action: "in", user_id: person().id, replayed: false });
    expect(again).toEqual({ ...first, replayed: true });
    expect((await rowsFor(key)).map((r) => r.organization_id)).toEqual([alpha()]);
  });

  it("090: a company the person is not working in, or none, is refused; 050's checks still apply after it", async () => {
    await switchTo(alpha());
    expect(await refusal("select public.record_attendance_event_in_company($1, 'in', null, null, $2)", [randomUUID(), randomUUID()])).toMatchObject({ code: "42501", hint: "wrong_company" });
    expect(await refusal("select public.record_attendance_event_in_company($1, 'in', null, null, null)", [randomUUID()])).toMatchObject({ code: "22023", hint: "expected_org_missing" });
    expect(await refusal("select public.record_attendance_event_in_company($1, 'lunch', null, null, $2)", [randomUUID(), alpha()])).toMatchObject({ code: "22023", hint: "bad_action" });
    expect(await refusal("select public.record_attendance_event_in_company(null, 'in', null, null, $1)", [alpha()])).toMatchObject({ code: "22023", hint: "client_op_missing" });
  });
});

describe("a switch committed between 090's check and 050's own read of the company", () => {
  it("is caught by the second check: refused, and the row 050 wrote is rolled back", async () => {
    await switchTo(alpha());
    const key = randomUUID();
    const outcome = await withDb(async (db: Client) => {
      await db.query("begin");
      try {
        // Inside this transaction only (rolled back below): 050's company lookup first moves the session to beta, as tab 2's
        // switch_organization committing at exactly that moment would, then answers from the session as 050 does.
        await db.query(`create or replace function public.time_caller_org() returns uuid language plpgsql volatile set search_path = pg_catalog, public as $f$
          begin
            update security_audit.session_company set organization_id = '${beta()}' where session_id = '${session}';
            return public.current_user_organization_id();
          end $f$`);
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({ sub: person().id, role: "authenticated", aud: "authenticated", session_id: session, aal: "aal1" })]);
        const before = (await db.query<{ org: string }>("select public.current_user_organization_id() as org")).rows[0].org;
        await db.query("savepoint call");
        let error: { code?: string; hint?: string } | null = null;
        try {
          await db.query("select public.record_attendance_event_in_company($1, 'in', null, 'Tab 1', $2)", [key, alpha()]);
        } catch (err) {
          error = err as { code?: string; hint?: string };
        }
        await db.query("rollback to savepoint call");
        await db.query("reset role");
        const rows = (await db.query("select organization_id from public.attendance_events where client_op_id = $1", [key])).rows;
        return { before, error: error && { code: error.code, hint: error.hint }, rows };
      } finally {
        await db.query("rollback");
      }
    });
    // The session was in alpha when 090 checked it, so the refusal is the second check's.
    expect(outcome).toEqual({ before: alpha(), error: { code: "42501", hint: "wrong_company" }, rows: [] });
    expect(await rowsFor(key)).toEqual([]);
  });
});

describe("090's function", () => {
  it("is a definer with a fixed search_path, callable by authenticated and not by anon; 050's function is unchanged beside it", async () => {
    const [row] = await owner<{ definer: boolean; config: string[]; auth: boolean; anon: boolean; old_auth: boolean; old_anon: boolean }>(
      `select p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.record_attendance_event(uuid,text,timestamp with time zone,text)'::regprocedure, 'EXECUTE') as old_auth,
              has_function_privilege('anon', 'public.record_attendance_event(uuid,text,timestamp with time zone,text)'::regprocedure, 'EXECUTE') as old_anon
       from pg_proc p where p.oid = 'public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)'::regprocedure`);
    expect(row).toEqual({ definer: true, config: ["search_path=pg_catalog, public"], auth: true, anon: false, old_auth: true, old_anon: false });
  });
});
