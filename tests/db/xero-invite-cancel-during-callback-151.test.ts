/**
 * Release 151, combined #437 + #438: cancelling an accountant's connect link while the Xero callback is completing.
 *
 * Code under test: public.integration_invite_revoke (#438: locks the invite row, then re-reads completion) and
 * public.integration_invite_store_connection (#437 at 6d147b9+: locks the OAuth state row, then the invite row, re-checks revoked/expired,
 * stores through the ordinary store and marks the state completed). Both lock the INVITE row, so every ordering below is decided by that one lock.
 *
 * Real concurrency, as in tests/reviews/pending-oauth: each actor is its own committed database connection (own transaction); a connection that
 * has run its function but not committed holds the invite lock; the other function is started on a second connection and the test polls
 * pg_stat_activity until that backend is really waiting on a lock (wait_event_type = 'Lock') before the first one commits. No sleeps, no mocks.
 *
 * The Xero organisation is deliberately named differently from the company (there is no name rule since 6d147b9: the immutable tenant id is what is stored).
 * Disposable database only (isolation guard). Committed rows are synthetic (t- slugs, @example.test) and removed in afterAll.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

type Actor = { id: string; org: string; session: string };
type Json = Record<string, unknown>;
const run = randomBytes(3).toString("hex");
const orgsMade: string[] = [];
const peopleMade: string[] = [];
const clients: Client[] = [];
let counter = 0;

const cipher = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}`;
const newRef = () => randomBytes(16).toString("base64url");
const newHash = () => randomBytes(32).toString("hex");

/** A new connection inside an open transaction, as the API would run it (service role, or an authenticated company admin at aal2). Always ended in afterEach-style `finish`. */
async function connect(role?: "authenticated" | "service_role", actor?: Actor) {
  const c = new Client({ connectionString: isolatedBackend().databaseUrl });
  await c.connect();
  clients.push(c);
  await c.query("BEGIN");
  if (role) await c.query(`SET LOCAL ROLE ${role}`);
  if (actor) {
    const claims = { sub: actor.id, session_id: actor.session, role: "authenticated", aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] };
    await c.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify(claims), actor.id]);
  }
  return c;
}
async function release(c: Client) {
  await c.query("ROLLBACK").catch(() => undefined);
  await c.end().catch(() => undefined);
}
/** One call in its own committed transaction. */
async function once<T = Json>(role: "authenticated" | "service_role", actor: Actor | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await connect(role, actor);
  try {
    const rows = (await c.query(sql, params)).rows as T[];
    await c.query("COMMIT");
    return rows;
  } finally {
    await release(c);
  }
}

const REVOKE = "select integration_invite_revoke($1) as r";
const STORE = "select integration_invite_store_connection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r";
const storeArgs = (state: string, a: Actor, tenantName: string) =>
  [state, a.org, a.id, "xero", randomUUID(), tenantName, randomUUID(), cipher(), cipher(), new Date(Date.now() + 1800_000).toISOString(), 1];

async function makeCompany(label: string): Promise<Actor> {
  return withDb(async (db) => {
    counter += 1;
    const org = randomUUID(), id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
    await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [org, `X151 cancel ${label} ${run}`, `t-x151c-${run}-${label}-${counter}`]);
    orgsMade.push(org);
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
    peopleMade.push(id);
    await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic','admin',$3,true,false)", [id, email, org]);
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'admin',true)", [id, org]);
    await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
    await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, id, org]);
    return { id, org, session };
  });
}
/** The invite exactly as the callback leaves it before the final write: create -> code issue -> code verify -> consume (state used up). */
async function consumedInvite(a: Actor) {
  const ref = newRef(), codeHash = newHash(), state = newHash();
  const made = (await once<{ r: { id: string } }>("authenticated", a, "select integration_invite_create('xero',$1,'accountant@firm.example') as r", [ref]))[0].r;
  await once("service_role", undefined, "select integration_invite_code_issue($1,$2)", [ref, codeHash]);
  await once("service_role", undefined, "select integration_invite_code_verify($1,$2,$3,$4)", [ref, codeHash, state, cipher()]);
  const consumed = (await once<{ c: Json | null }>("service_role", undefined, "select integration_oauth_consume_invite('xero',$1) as c", [state]))[0].c;
  expect(consumed).toMatchObject({ organization_id: a.org, user_id: a.id });
  return { id: made.id, ref, state };
}

const connections = (org: string) => withDb(async (db) => (await db.query("SELECT tenant_name FROM public.integration_connections WHERE organization_id=$1 AND provider='xero'", [org])).rows as Array<{ tenant_name: string }>);
const completedAt = (state: string) => withDb(async (db) => (await db.query("SELECT invite_completed_at FROM public.integration_oauth_states WHERE state_hash=$1", [state])).rows[0].invite_completed_at as Date | null);
const revokeAudits = (org: string) => withDb(async (db) => (await db.query("SELECT actor_user_id, metadata FROM security_audit.audit_log WHERE organization_id=$1 AND action='INTEGRATION_INVITE_REVOKED'", [org])).rows);
const inviteRow = (id: string) => withDb(async (db) => (await db.query("SELECT revoked_at, revoke_reason FROM public.integration_connect_invites WHERE id=$1", [id])).rows[0] as { revoked_at: Date | null; revoke_reason: string | null });

/** Waits until `count` backends of this database are blocked on a lock while running a statement that starts with `prefix`. */
async function waitForLockWaiters(prefix: string, count: number) {
  await expect.poll(
    async () => withDb(async (db) => Number((await db.query(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1", [`${prefix}%`])).rows[0].n)),
    { timeout: 10_000, interval: 25 },
  ).toBe(count);
}

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
});
afterAll(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  await withDb(async (db) => {
    for (const org of orgsMade) await db.query("DELETE FROM public.organizations WHERE id=$1", [org]).catch(() => undefined);
    for (const id of peopleMade) await db.query("DELETE FROM auth.users WHERE id=$1", [id]).catch(() => undefined);
  }).catch(() => undefined);
});

describe("cancelling a connect link during the Xero callback (combined #437 store + #438 revoke)", () => {
  const XERO_NAME = () => `Unrelated Trading Partners ${run}`; // not the company's name: no name rule applies

  it("(a) a revoke committed before the final store: the store refuses, no connection is made, the state is never marked completed", async () => {
    const a = await makeCompany("a");
    const inv = await consumedInvite(a);
    expect((await once<{ r: boolean }>("authenticated", a, REVOKE, [inv.id]))[0].r).toBe(true);
    const stored = (await once<{ r: Json }>("service_role", undefined, STORE, storeArgs(inv.state, a, XERO_NAME())))[0].r;
    expect(stored.ok).toBe(false);
    expect(await connections(a.org)).toEqual([]);
    expect(await completedAt(inv.state)).toBeNull();
    expect(await revokeAudits(a.org)).toHaveLength(1);
    expect((await inviteRow(inv.id)).revoke_reason).toBe("cancelled");
  });

  it("(b) the final store holds the invite lock while a revoke waits: after the store commits the revoke returns false and the connection exists exactly once", async () => {
    const a = await makeCompany("b");
    const inv = await consumedInvite(a);
    const store = await connect("service_role");
    let attempt: Promise<boolean> | undefined;
    try {
      const stored = (await store.query(STORE, storeArgs(inv.state, a, XERO_NAME()))).rows[0].r as Json;
      expect(stored.ok).not.toBe(false); // stored, not yet committed: this transaction owns the state row and the invite row
      attempt = once<{ r: boolean }>("authenticated", a, REVOKE, [inv.id]).then((rows) => rows[0].r);
      await waitForLockWaiters("select integration_invite_revoke", 1);
      await store.query("COMMIT");
      expect(await attempt).toBe(false);
    } finally {
      await release(store);
      await Promise.allSettled([attempt]);
    }
    expect(await connections(a.org)).toEqual([{ tenant_name: XERO_NAME() }]);
    expect(await completedAt(inv.state)).not.toBeNull();
    expect(await revokeAudits(a.org)).toEqual([]);
    expect((await inviteRow(inv.id)).revoked_at).toBeNull();
    // and the completed consent cannot be replayed
    expect((await once<{ r: Json }>("service_role", undefined, STORE, storeArgs(inv.state, a, XERO_NAME())))[0].r.ok).toBe(false);
    expect(await connections(a.org)).toHaveLength(1);
  });

  it("(c) a revoke holds the invite lock while the final store waits: after the revoke commits the store refuses, no connection, no completion marker", async () => {
    const a = await makeCompany("c");
    const inv = await consumedInvite(a);
    const revoker = await connect("authenticated", a);
    let attempt: Promise<Json> | undefined;
    try {
      expect((await revoker.query(REVOKE, [inv.id])).rows[0].r).toBe(true); // revoked, not yet committed
      attempt = once<{ r: Json }>("service_role", undefined, STORE, storeArgs(inv.state, a, XERO_NAME())).then((rows) => rows[0].r);
      await waitForLockWaiters("select integration_invite_store_connection", 1);
      await revoker.query("COMMIT");
      expect((await attempt).ok).toBe(false);
    } finally {
      await release(revoker);
      await Promise.allSettled([attempt]);
    }
    expect(await connections(a.org)).toEqual([]);
    expect(await completedAt(inv.state)).toBeNull();
    expect(await revokeAudits(a.org)).toHaveLength(1);
  });

  it("(d) two concurrent revokes of the same invite: exactly one wins and exactly one audit row is written", async () => {
    const a = await makeCompany("d");
    const inv = await consumedInvite(a);
    const first = await connect("authenticated", a);
    let second: Promise<boolean> | undefined;
    let firstResult: unknown;
    try {
      firstResult = (await first.query(REVOKE, [inv.id])).rows[0].r; // holds the invite lock, uncommitted
      second = once<{ r: boolean }>("authenticated", a, REVOKE, [inv.id]).then((rows) => rows[0].r);
      await waitForLockWaiters("select integration_invite_revoke", 1);
      await first.query("COMMIT");
      const secondResult = await second;
      expect([firstResult, secondResult].sort()).toEqual([false, true]);
      expect(firstResult).toBe(true);
    } finally {
      await release(first);
      await Promise.allSettled([second]);
    }
    expect(await revokeAudits(a.org)).toHaveLength(1);
    expect((await revokeAudits(a.org))[0]).toMatchObject({ actor_user_id: a.id });
    expect(await connections(a.org)).toEqual([]);
  });

  it("(d2) two revokes both waiting behind a third lock holder: one winner, one audit row, no deadlock", async () => {
    const a = await makeCompany("d2");
    const inv = await consumedInvite(a);
    const holder = await connect(); // the table owner: a plain row lock on the invite, as tests/reviews/pending-oauth does
    let attempts: Array<Promise<boolean>> = [];
    try {
      await holder.query("SELECT id FROM public.integration_connect_invites WHERE id=$1 FOR UPDATE", [inv.id]);
      attempts = [1, 2].map(() => once<{ r: boolean }>("authenticated", a, REVOKE, [inv.id]).then((rows) => rows[0].r));
      await waitForLockWaiters("select integration_invite_revoke", 2);
      await holder.query("COMMIT");
      expect((await Promise.all(attempts)).filter(Boolean)).toHaveLength(1);
    } finally {
      await release(holder);
      await Promise.allSettled(attempts);
    }
    expect(await revokeAudits(a.org)).toHaveLength(1);
  });
});
