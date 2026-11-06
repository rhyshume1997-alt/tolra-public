/**
 * Proposal 151 (release 151_xero_invite_hardening): the accountant's Xero connect link as an opaque reference + a code e-mailed to the bound address.
 * Pure SQL through the database connection, as the API runs it (role authenticated with JWT claims, or the service role), on a disposable database only.
 * The file installs the 151 release if it is not there and puts the database back to its earlier state when it finishes (151 is not in the release plan).
 *
 * Proved here (adversarial cases included):
 *   - create: the company's own admin only (office, support sessions, other companies refused), Xero only, a 22-character reference, a plain recipient
 *     address, at most three open; nothing about the invite is readable through the API;
 *   - the page (peek) gives the company and the MASKED address only, for an open invite; nothing is used up;
 *   - the code goes to the BOUND address (the function takes none from the caller); only a hash is stored; five codes, one a minute;
 *   - a forwarded link without the mailbox cannot pass: wrong codes count, the fifth locks the invite for good, even the right code then fails;
 *     attempts are never reset by asking for another code;
 *   - single use: a replay after redeem, an expired invite, a revoked invite, an expired code and a tampered reference are all refused;
 *   - bound to ONE company and the creating admin: a demoted or removed creator or a closed company ends the invite at once;
 *   - exactly one of two simultaneous redeems wins;
 *   - company audit rows for created / opened / code issued / verified / used / revoked / expired carry no reference, code, hash or full address;
 *   - EVERY refusal is a row of the SECURITY LOG (security_audit.integration_invite_refusals) with a correlation id, never a company audit row; only a hash of
 *     the reference is kept, and a company only when a matched invite proves it (tests "BLOCK: untraceable refusals");
 *   - expiry is enforced by the database on EVERY use (page, code request, code check, redeem, the OAuth callback): "BLOCK: expired still redeemable";
 *   - the recipient check cannot be bypassed by forwarding: "BLOCK: forwarded link bypassing the recipient check";
 *   - a connection made this way is like any other (release 149): transfers stay OFF and queued documents stay held;
 *   - the rollback refuses while an invite is open, restores 107's functions, and the release installs again (and refuses a second install).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const RELEASE = "supabase/release/151_xero_invite_hardening.release.sql";
const ROLLBACK = "supabase/release/151_xero_invite_hardening.rollback.sql";
const VERIFY = "supabase/verify/xero_invite_hardening_151.sql";
type Db = Pick<Client, "query">;
type Actor = { id: string; session: string; org: string; email: string; role: string };
type Err = { code?: string; message: string; hint?: string };
type Json = Record<string, unknown>;
const orgsMade: string[] = [];
const peopleMade: string[] = [];
let counter = 0;
let weInstalled = false;
const run = randomBytes(3).toString("hex");

const cipher = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}`;
const newRef = () => randomBytes(16).toString("base64url");
const newHash = () => randomBytes(32).toString("hex");
const installed = async (db: Db) => (await db.query("SELECT to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') IS NOT NULL AS t")).rows[0].t as boolean;

async function makeOrg(db: Db, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `X151 ${label} ${run}`, `t-x151-${run}-${label}-${counter}`]);
  orgsMade.push(id);
  return id;
}
async function makeActor(db: Db, org: string, role: string, opts: { support?: boolean } = {}): Promise<Actor> {
  const id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)", [id, email, role, org]);
  peopleMade.push(id);
  let grant: string | null = null;
  if (opts.support) {
    await db.query("INSERT INTO security_audit.platform_admins(user_id) VALUES($1)", [id]);
    grant = randomUUID();
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active,support,expires_at,support_grant) VALUES($1,$2,$3,true,true,now()+interval '2 hours',$4)", [id, org, role, grant]);
  } else {
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)", [id, org, role]);
  }
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id,grant_id) VALUES($1,$2,$3,$4)", [session, id, org, grant]);
  return { id, session, org, email, role };
}
async function as<T = Json>(db: Db, who: Actor | "anon", sql: string, params: unknown[] = [], o: { aal?: string; recent?: number } = {}): Promise<{ rows?: T[]; error?: Err }> {
  await db.query("SAVEPOINT x151_call");
  try {
    if (who === "anon") await db.query("SET LOCAL ROLE anon");
    else {
      await db.query("SET LOCAL ROLE authenticated");
      const claims: Record<string, unknown> = { sub: who.id, session_id: who.session, role: "authenticated", aal: o.aal ?? "aal2", email: who.email };
      if (o.recent !== undefined) claims.amr = [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - o.recent }];
      await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify(claims), who.id]);
    }
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT x151_call");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT x151_call");
    await db.query("RESET ROLE");
    const err = e as Err;
    return { error: { code: err.code, message: err.message, hint: err.hint } };
  }
}
async function svc<T = Json>(db: Db, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: Err }> {
  await db.query("SAVEPOINT x151_svc");
  try {
    await db.query("SET LOCAL ROLE service_role");
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT x151_svc");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT x151_svc");
    await db.query("RESET ROLE");
    const err = e as Err;
    return { error: { code: err.code, message: err.message, hint: err.hint } };
  }
}
const ok = <T>(r: { rows?: T[]; error?: Err }) => { if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`); return r.rows!; };
async function committed<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try { const out = await fn(); await db.query("COMMIT"); return out; } catch (e) { await db.query("ROLLBACK").catch(() => undefined); throw e; }
}
async function inTx(fn: (db: Client) => Promise<void>) {
  await withDb(async (db) => {
    await db.query("BEGIN");
    try { await fn(db); } finally { await db.query("ROLLBACK"); }
  });
}

type Co = { org: string; admin: Actor; office: Actor };
async function company(db: Db, label: string): Promise<Co> {
  const org = await makeOrg(db, label);
  return { org, admin: await makeActor(db, org, "admin"), office: await makeActor(db, org, "office") };
}
const RECIPIENT = "accountant@firm.example";
type Made = { id: string; ref: string; recipient: string };
async function create(db: Db, who: Actor, recipient = RECIPIENT, ref = newRef()): Promise<Made> {
  const r = ok(await as<{ r: { id: string } }>(db, who, "SELECT public.integration_invite_create('xero',$1,$2) AS r", [ref, recipient]))[0].r;
  return { id: r.id, ref, recipient };
}
const issue = async (db: Db, ref: string, hash = newHash()) => ok(await svc<{ r: Json }>(db, "SELECT public.integration_invite_code_issue($1,$2) AS r", [ref, hash]))[0].r;
const verify = async (db: Db, ref: string, hash: string, state = newHash()) => ok(await svc<{ r: Json }>(db, "SELECT public.integration_invite_code_verify($1,$2,$3,$4) AS r", [ref, hash, state, cipher()]))[0].r;
const peek = async (db: Db, ref: string) => ok(await svc<{ r: Json | null }>(db, "SELECT public.integration_invite_peek($1) AS r", [ref]))[0].r;
const row = async (db: Db, id: string) => (await db.query("SELECT * FROM public.integration_connect_invites WHERE id=$1", [id])).rows[0] as Json;
const audit = async (db: Db, org: string, action?: string) =>
  (await db.query("SELECT action, entity_id, metadata FROM security_audit.audit_log WHERE organization_id=$1 AND entity_table='integration_connect_invites' AND ($2::text IS NULL OR action=$2) ORDER BY created_at, id", [org, action ?? null])).rows as Array<{ action: string; entity_id: string; metadata: Json }>;
const states = async (db: Db, id: string) => (await db.query("SELECT count(*)::int AS n FROM public.integration_oauth_states WHERE via_invite=$1", [id])).rows[0].n as number;
const refusals = async (db: Db, org: string) =>
  (await db.query("SELECT correlation_id, step, reason, ref_hash, organization_id FROM security_audit.integration_invite_refusals WHERE organization_id=$1 ORDER BY id", [org])).rows as Array<{ correlation_id: string; step: string; reason: string; ref_hash: string | null; organization_id: string | null }>;
const refusalById = async (db: Db, id: unknown) =>
  (await db.query("SELECT correlation_id, step, reason, ref_hash, organization_id FROM security_audit.integration_invite_refusals WHERE correlation_id=$1", [id])).rows as Array<{ step: string; reason: string; ref_hash: string | null; organization_id: string | null }>;
const hashOf = async (db: Db, ref: string) => (await db.query("SELECT left(encode(sha256(convert_to($1,'UTF8')),'hex'),16) AS h", [ref])).rows[0].h as string;
/** Make the invite older than 24 hours (the table allows at most 24 hours between made and expires). */
const expireNow = (db: Db, id: string) => db.query("UPDATE public.integration_connect_invites SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id=$1", [id]);
/** Let the 60-second pause between codes pass. */
const unthrottle = (db: Db, id: string) => db.query("UPDATE public.integration_connect_invites SET code_sent_at = now() - interval '2 minutes' WHERE id=$1", [id]);

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  await withDb(async (db) => {
    if (!(await installed(db))) { await db.query(read(RELEASE)); weInstalled = true; }
  });
});
afterAll(async () => {
  await withDb(async (db) => {
    for (const org of orgsMade) await db.query("DELETE FROM public.organizations WHERE id=$1", [org]).catch(() => undefined);
    for (const id of peopleMade) await db.query("DELETE FROM auth.users WHERE id=$1", [id]).catch(() => undefined);
    // 151 is not part of the release plan: leave the database as it was found.
    if (weInstalled && (await installed(db))) {
      await db.query("SET tolra.x151_accept_deleting_open_invites = 'yes'");
      await db.query(read(ROLLBACK));
    }
  }).catch(() => undefined);
});

it("the verify file: every row true", async () => {
  await withDb(async (db) => {
    const checks = (await db.query(read(VERIFY))).rows;
    expect(checks.length).toBe(14);
    expect(checks.filter((r) => r.ok !== true)).toEqual([]);
  });
});

describe("create, peek and the API's view", () => {
  it("the company's own admin only: office, a support session, another company's admin, anon; Xero only; a 22-character reference; a plain address", async () => {
    await inTx(async (db) => {
      const a = await company(db, "create-a");
      const b = await company(db, "create-b");
      const support = await makeActor(db, a.org, "admin", { support: true });
      const sql = "SELECT public.integration_invite_create($1,$2,$3)";
      expect((await as(db, a.office, sql, ["xero", newRef(), RECIPIENT])).error).toMatchObject({ code: "42501" });
      expect((await as(db, support, sql, ["xero", newRef(), RECIPIENT])).error).toMatchObject({ code: "42501" });
      expect((await as(db, "anon", sql, ["xero", newRef(), RECIPIENT])).error).toMatchObject({ code: "42501" });
      expect((await as(db, a.admin, sql, ["microsoft", newRef(), RECIPIENT])).error).toMatchObject({ code: "22023" });
      for (const ref of [newRef().slice(1), `${newRef()}x`, `${newRef().slice(1)} `, `${newRef().slice(1)}'`, "", "x".repeat(43)]) expect((await as(db, a.admin, sql, ["xero", ref, RECIPIENT])).error, ref).toMatchObject({ code: "22023" });
      for (const to of ["", "nobody", "A@Firm.example", "a@b", "a b@firm.example", "a@firm.example,b@firm.example", "a@firm.example\r\nbcc:x@y.example", "<a@firm.example>", `${"a".repeat(250)}@firm.example`]) {
        expect((await as(db, a.admin, sql, ["xero", newRef(), to])).error, to).toMatchObject({ code: "22023" });
      }
      const made = await create(db, a.admin);
      // another company's admin cannot see or cancel it
      expect(ok(await as<{ r: unknown[] }>(db, b.admin, "SELECT public.integration_invites_open('xero') AS r"))[0].r).toEqual([]);
      expect(ok(await as<{ r: boolean }>(db, b.admin, "SELECT public.integration_invite_revoke($1) AS r", [made.id]))[0].r).toBe(false);
      expect((await row(db, made.id)).revoked_at).toBeNull();
      // nothing about invites is readable or writable through the API
      for (const who of [a.admin, a.office, b.admin, "anon" as const]) {
        expect((await as(db, who, "SELECT count(*) FROM public.integration_connect_invites")).error).toMatchObject({ code: "42501" });
        expect((await as(db, who, "UPDATE public.integration_connect_invites SET used_at = null")).error).toMatchObject({ code: "42501" });
      }
      // the three server-only functions are for the service role only
      for (const who of [a.admin, a.office, "anon" as const]) {
        expect((await as(db, who, "SELECT public.integration_invite_peek($1)", [made.ref])).error).toMatchObject({ code: "42501" });
        expect((await as(db, who, "SELECT public.integration_invite_code_issue($1,$2)", [made.ref, newHash()])).error).toMatchObject({ code: "42501" });
        expect((await as(db, who, "SELECT public.integration_invite_code_verify($1,$2,$3,$4)", [made.ref, newHash(), newHash(), cipher()])).error).toMatchObject({ code: "42501" });
      }
    });
  });

  it("at most three open per company; the admin's list shows the address but never the reference, a code or a hash", async () => {
    await inTx(async (db) => {
      const a = await company(db, "three");
      const made = [await create(db, a.admin), await create(db, a.admin), await create(db, a.admin)];
      expect((await as(db, a.admin, "SELECT public.integration_invite_create('xero',$1,$2)", [newRef(), RECIPIENT])).error).toMatchObject({ code: "54000", hint: "too_many_invites" });
      await issue(db, made[0].ref, newHash());
      const list = ok(await as<{ r: Array<Json> }>(db, a.admin, "SELECT public.integration_invites_open('xero') AS r"))[0].r;
      expect(list).toHaveLength(3);
      expect(list[0]).toMatchObject({ recipient: RECIPIENT });
      const text = JSON.stringify(list);
      for (const m of made) expect(text).not.toContain(m.ref);
      expect(text).not.toMatch(/code_hash|"ref"|token/);
    });
  });

  it("the page: company name and MASKED address for an open invite only; nothing is used up; unknown, malformed and tampered references give null", async () => {
    await inTx(async (db) => {
      const a = await company(db, "peek");
      const made = await create(db, a.admin);
      for (let i = 0; i < 3; i += 1) {
        const p = await peek(db, made.ref);
        expect(p).toMatchObject({ provider: "xero", recipient_hint: "a***@firm.example" });
        expect(String(p!.company_name)).toContain("X151 peek");
        expect(JSON.stringify(p)).not.toContain(RECIPIENT);
      }
      const r = await row(db, made.id);
      expect([r.used_at, r.code_hash, r.code_sent_count, r.code_attempts]).toEqual([null, null, 0, 0]);
      const flip = (s: string) => `${s.slice(0, 5)}${s[5] === "A" ? "B" : "A"}${s.slice(6)}`;
      for (const bad of [newRef(), flip(made.ref), made.ref.toLowerCase() === made.ref ? made.ref.toUpperCase() : made.ref.toLowerCase(), made.ref.slice(1), `${made.ref}x`, ` ${made.ref.slice(1)}`, "' or 1=1 --", "%".repeat(22)]) {
        if (bad === made.ref) continue;
        expect(await peek(db, bad), bad).toBeNull();
      }
      expect(await audit(db, a.org)).toHaveLength(1); // only CREATED: looking at it records nothing
    });
  });
});

describe("the code, single use and the whole path", () => {
  it("issue: the BOUND address comes back (the function takes none); only the hash is stored; then verify uses it up and keeps a state for that company and admin; audit in order", async () => {
    await inTx(async (db) => {
      const a = await company(db, "happy");
      const made = await create(db, a.admin);
      const hash = newHash();
      const out = await issue(db, made.ref, hash);
      expect(out).toMatchObject({ ok: true, recipient: RECIPIENT, organization_id: a.org, sent_number: 1 });
      const stored = await row(db, made.id);
      expect(stored.code_hash).toBe(hash);
      expect(Date.parse(String(stored.code_expires_at)) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      const state = newHash();
      const v = await verify(db, made.ref, hash, state);
      expect(v).toEqual({ ok: true, organization_id: a.org, provider: "xero" });
      const used = await row(db, made.id);
      expect(used.used_at).not.toBeNull();
      expect(used.code_hash).toBeNull();
      expect(await states(db, made.id)).toBe(1);
      const consumed = ok(await svc<{ c: Json | null }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c;
      expect(consumed).toMatchObject({ organization_id: a.org, user_id: a.admin.id });
      expect(ok(await svc<{ c: Json | null }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c).toBeNull();
      expect((await audit(db, a.org)).map((e) => e.action)).toEqual(["INTEGRATION_INVITE_CREATED", "INTEGRATION_INVITE_OPENED", "INTEGRATION_INVITE_CODE_ISSUED", "INTEGRATION_INVITE_VERIFIED", "INTEGRATION_INVITE_USED"]);
    });
  });

  it("replay after redeem: the same code, a new code request and a peek are all refused; no second state; the refusals are in the security log as 'used'", async () => {
    await inTx(async (db) => {
      const a = await company(db, "replay");
      const made = await create(db, a.admin);
      const hash = newHash();
      await issue(db, made.ref, hash);
      await verify(db, made.ref, hash);
      expect(await verify(db, made.ref, hash)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await issue(db, made.ref)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await peek(db, made.ref)).toBeNull();
      expect(await states(db, made.id)).toBe(1);
      expect((await refusals(db, a.org)).map((r) => r.reason)).toEqual(["used", "used"]);
      expect(await audit(db, a.org, "INTEGRATION_INVITE_REFUSED")).toEqual([]); // a refusal is not the company's audit
    });
  });

  it("a forwarded link: whoever lacks the mailbox can only guess; five wrong codes lock the invite for good, and then even the right code fails", async () => {
    await inTx(async (db) => {
      const a = await company(db, "forward");
      const made = await create(db, a.admin);
      const good = newHash();
      await issue(db, made.ref, good);
      for (let n = 1; n <= 4; n += 1) expect(await verify(db, made.ref, newHash())).toMatchObject({ ok: false, reason: "wrong_code", attempts_left: 5 - n });
      expect(await verify(db, made.ref, newHash())).toMatchObject({ ok: false, reason: "locked" });
      const r = await row(db, made.id);
      expect(r.locked_at).not.toBeNull();
      expect(r.revoked_at).not.toBeNull();
      expect(r.revoke_reason).toBe("locked");
      expect(r.code_hash).toBeNull();
      expect(await verify(db, made.ref, good)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await issue(db, made.ref)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await peek(db, made.ref)).toBeNull();
      expect(await states(db, made.id)).toBe(0);
      expect((await refusals(db, a.org)).map((r) => r.reason).slice(0, 5)).toEqual(["wrong_code", "wrong_code", "wrong_code", "wrong_code", "locked"]);
    });
  });

  it("asking for another code never resets the count of wrong guesses", async () => {
    await inTx(async (db) => {
      const a = await company(db, "noreset");
      const made = await create(db, a.admin);
      await issue(db, made.ref, newHash());
      for (let n = 0; n < 4; n += 1) await verify(db, made.ref, newHash());
      await unthrottle(db, made.id);
      const fresh = newHash();
      expect(await issue(db, made.ref, fresh)).toMatchObject({ ok: true, sent_number: 2 });
      expect(await verify(db, made.ref, newHash())).toMatchObject({ ok: false, reason: "locked" });
      expect(await verify(db, made.ref, fresh)).toMatchObject({ ok: false, reason: "invalid" });
    });
  });

  it("codes: one a minute, five per invite; a new code replaces the old one", async () => {
    await inTx(async (db) => {
      const a = await company(db, "limits");
      const made = await create(db, a.admin);
      const first = newHash();
      await issue(db, made.ref, first);
      expect(await issue(db, made.ref)).toMatchObject({ ok: false, reason: "wait" });
      await unthrottle(db, made.id);
      const second = newHash();
      expect(await issue(db, made.ref, second)).toMatchObject({ ok: true, sent_number: 2 });
      expect(await verify(db, made.ref, first)).toMatchObject({ ok: false, reason: "wrong_code" });
      for (let n = 3; n <= 5; n += 1) { await unthrottle(db, made.id); expect(await issue(db, made.ref)).toMatchObject({ ok: true, sent_number: n }); }
      await unthrottle(db, made.id);
      expect(await issue(db, made.ref)).toMatchObject({ ok: false, reason: "too_many_codes" });
      expect((await audit(db, a.org, "INTEGRATION_INVITE_OPENED"))).toHaveLength(1);
      expect((await audit(db, a.org, "INTEGRATION_INVITE_CODE_ISSUED"))).toHaveLength(5);
    });
  });

  it("an expired code: refused, nothing used up, a fresh code still works", async () => {
    await inTx(async (db) => {
      const a = await company(db, "codeexp");
      const made = await create(db, a.admin);
      const hash = newHash();
      await issue(db, made.ref, hash);
      await db.query("UPDATE public.integration_connect_invites SET code_expires_at = now() - interval '1 second' WHERE id=$1", [made.id]);
      expect(await verify(db, made.ref, hash)).toMatchObject({ ok: false, reason: "code_expired" });
      const r = await row(db, made.id);
      expect([r.used_at, r.revoked_at, r.code_attempts]).toEqual([null, null, 0]);
      expect(await states(db, made.id)).toBe(0);
      await unthrottle(db, made.id);
      const fresh = newHash();
      await issue(db, made.ref, fresh);
      expect(await verify(db, made.ref, fresh)).toMatchObject({ ok: true });
      // no code was ever requested: also "code_expired", never a pass
      const other = await create(db, a.admin);
      expect(await verify(db, other.ref, newHash())).toMatchObject({ ok: false, reason: "code_expired" });
    });
  });

  it("a malformed hash is refused outright (22023); a tampered or unknown reference changes nothing, writes no company audit row, and leaves a security-log row with a correlation id", async () => {
    await inTx(async (db) => {
      const a = await company(db, "tamper");
      const made = await create(db, a.admin);
      await issue(db, made.ref, newHash());
      const before = await row(db, made.id);
      for (const bad of ["", "xyz", "A".repeat(64), newHash().slice(1)]) {
        expect((await svc(db, "SELECT public.integration_invite_code_issue($1,$2)", [made.ref, bad])).error, bad).toMatchObject({ code: "22023" });
        expect((await svc(db, "SELECT public.integration_invite_code_verify($1,$2,$3,$4)", [made.ref, bad, newHash(), cipher()])).error, bad).toMatchObject({ code: "22023" });
      }
      const flip = (s: string) => `${s.slice(0, 3)}${s[3] === "A" ? "B" : "A"}${s.slice(4)}`;
      for (const ref of [flip(made.ref), newRef(), made.ref.slice(1), `${made.ref}0`, "", "' OR '1'='1"]) {
        const v = await verify(db, ref, newHash());
        const i = await issue(db, ref);
        expect(v).toMatchObject({ ok: false, reason: "invalid" });
        expect(i).toMatchObject({ ok: false, reason: "invalid" });
        for (const out of [v, i]) {
          const logged = await refusalById(db, out.correlation_id);
          expect(logged, ref).toHaveLength(1);
          expect(logged[0].organization_id).toBeNull(); // a company only from a MATCHED invite
          expect(logged[0].reason).toMatch(/^(unknown_ref|malformed_ref)$/);
        }
      }
      expect(await row(db, made.id)).toEqual(before);
      expect((await audit(db, a.org)).map((e) => e.action)).toEqual(["INTEGRATION_INVITE_CREATED", "INTEGRATION_INVITE_OPENED", "INTEGRATION_INVITE_CODE_ISSUED"]);
    });
  });

  it("expired: refused at every step, audited once (however often it is tried), and a company's next create also records expiries", async () => {
    await inTx(async (db) => {
      const a = await company(db, "expired");
      const ref = newRef();
      const id = (await db.query(`INSERT INTO public.integration_connect_invites (organization_id, provider, ref, recipient_email, created_by, created_at, expires_at)
        VALUES ($1,'xero',$2,$3,$4, now() - interval '25 hours', now() - interval '1 hour') RETURNING id`, [a.org, ref, RECIPIENT, a.admin.id])).rows[0].id as string;
      expect(await peek(db, ref)).toBeNull();
      expect(await issue(db, ref)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await verify(db, ref, newHash())).toMatchObject({ ok: false, reason: "invalid" });
      expect(await issue(db, ref)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await audit(db, a.org, "INTEGRATION_INVITE_EXPIRED")).toHaveLength(1);
      expect(await states(db, id)).toBe(0);
      // another one that no one ever opened is recorded when the admin makes the next invite
      const ref2 = newRef();
      await db.query(`INSERT INTO public.integration_connect_invites (organization_id, provider, ref, recipient_email, created_by, created_at, expires_at)
        VALUES ($1,'xero',$2,$3,$4, now() - interval '30 hours', now() - interval '6 hours')`, [a.org, ref2, RECIPIENT, a.admin.id]);
      await create(db, a.admin);
      expect(await audit(db, a.org, "INTEGRATION_INVITE_EXPIRED")).toHaveLength(2);
      await create(db, a.admin);
      expect(await audit(db, a.org, "INTEGRATION_INVITE_EXPIRED")).toHaveLength(2);
    });
  });

  it("revoked by the admin: refused at every step, audited with the reason; only the company's own admin can cancel (office, support, another company: no)", async () => {
    await inTx(async (db) => {
      const a = await company(db, "revoke-a");
      const b = await company(db, "revoke-b");
      const support = await makeActor(db, a.org, "admin", { support: true });
      const made = await create(db, a.admin);
      const hash = newHash();
      await issue(db, made.ref, hash);
      const sql = "SELECT public.integration_invite_revoke($1) AS r";
      expect((await as(db, a.office, sql, [made.id])).error).toMatchObject({ code: "42501" });
      expect((await as(db, support, sql, [made.id])).error).toMatchObject({ code: "42501" });
      expect(ok(await as<{ r: boolean }>(db, b.admin, sql, [made.id]))[0].r).toBe(false);
      expect(ok(await as<{ r: boolean }>(db, a.admin, sql, [made.id]))[0].r).toBe(true);
      expect(ok(await as<{ r: boolean }>(db, a.admin, sql, [made.id]))[0].r).toBe(false);
      const r = await row(db, made.id);
      expect([r.revoke_reason, r.revoked_by, r.code_hash]).toEqual(["cancelled", a.admin.id, null]);
      expect(await peek(db, made.ref)).toBeNull();
      expect(await verify(db, made.ref, hash)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await issue(db, made.ref)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await states(db, made.id)).toBe(0);
      const revoked = await audit(db, a.org, "INTEGRATION_INVITE_REVOKED");
      expect(revoked).toHaveLength(1);
      expect(revoked[0].metadata).toMatchObject({ reason: "cancelled", by: a.admin.id });
      expect((await refusals(db, a.org)).map((r) => r.reason)).toEqual(["revoked", "revoked"]);
    });
  });

  it("bound to ONE company: the state belongs to the invite's company, never another; a second company's invite is its own", async () => {
    await inTx(async (db) => {
      const a = await company(db, "bound-a");
      const b = await company(db, "bound-b");
      const ma = await create(db, a.admin);
      const mb = await create(db, b.admin, "other@firm.example");
      const ha = newHash(), hb = newHash();
      await issue(db, ma.ref, ha);
      await issue(db, mb.ref, hb);
      // company B's code does not open company A's invite, and vice versa
      expect(await verify(db, ma.ref, hb)).toMatchObject({ ok: false, reason: "wrong_code" });
      expect(await verify(db, mb.ref, ha)).toMatchObject({ ok: false, reason: "wrong_code" });
      expect(await verify(db, ma.ref, ha)).toMatchObject({ ok: true, organization_id: a.org });
      expect(await verify(db, mb.ref, hb)).toMatchObject({ ok: true, organization_id: b.org });
      const owners = (await db.query("SELECT via_invite, organization_id, user_id FROM public.integration_oauth_states WHERE via_invite = ANY($1)", [[ma.id, mb.id]])).rows;
      expect(owners.find((o) => o.via_invite === ma.id)).toMatchObject({ organization_id: a.org, user_id: a.admin.id });
      expect(owners.find((o) => o.via_invite === mb.id)).toMatchObject({ organization_id: b.org, user_id: b.admin.id });
    });
  });

  it("the creating admin must still be an active, non-support admin of an active company at every step: demoted, switched off or the company closed ends the invite", async () => {
    const cases: Array<[string, string]> = [
      ["demoted to office", "UPDATE public.organization_members SET role='office', secondary_role=null WHERE user_id=$1 AND organization_id=$2"],
      ["switched off", "UPDATE public.organization_members SET active=false WHERE user_id=$1 AND organization_id=$2"],
      ["removed", "DELETE FROM public.organization_members WHERE user_id=$1 AND organization_id=$2"],
      ["company closed", "UPDATE public.organizations SET status='closed' WHERE id=$2 AND $1::uuid IS NOT NULL"],
    ];
    for (const [label, sql] of cases) {
      await inTx(async (db) => {
        const a = await company(db, `demote-${label.split(" ")[0]}`);
        const made = await create(db, a.admin);
        const hash = newHash();
        await issue(db, made.ref, hash);
        await db.query(sql, [a.admin.id, a.org]);
        expect(await peek(db, made.ref), label).toBeNull();
        expect(await verify(db, made.ref, hash), label).toMatchObject({ ok: false, reason: "invalid" });
        expect(await states(db, made.id), label).toBe(0);
        const r = await row(db, made.id);
        expect(r.used_at, label).toBeNull();
        expect(r.revoke_reason, label).toBe("creator_not_admin");
        expect(await issue(db, made.ref), label).toMatchObject({ ok: false, reason: "invalid" });
        expect((await refusals(db, a.org)).map((r) => r.reason).slice(0, 1), label).toEqual(["creator_not_admin"]);
      });
    }
  });

  it("a second admin can't redeem for the first: the state always carries the CREATING admin, whoever else is an admin", async () => {
    await inTx(async (db) => {
      const a = await company(db, "twoadmins");
      const other = await makeActor(db, a.org, "admin");
      const made = await create(db, a.admin);
      const hash = newHash();
      await issue(db, made.ref, hash);
      await verify(db, made.ref, hash);
      const st = (await db.query("SELECT user_id FROM public.integration_oauth_states WHERE via_invite=$1", [made.id])).rows[0];
      expect(st.user_id).toBe(a.admin.id);
      expect(st.user_id).not.toBe(other.id);
    });
  });

  it("no reference, code hash, state, token or full address is in any audit row of the invites", async () => {
    await inTx(async (db) => {
      const a = await company(db, "hygiene");
      const made = await create(db, a.admin);
      const hash = newHash();
      const state = newHash();
      await issue(db, made.ref, hash);
      await verify(db, made.ref, newHash());
      await verify(db, made.ref, hash, state);
      await create(db, a.admin, "second@firm.example");
      const all = JSON.stringify(await audit(db, a.org));
      const log = JSON.stringify((await db.query("SELECT * FROM security_audit.integration_invite_refusals WHERE organization_id=$1", [a.org])).rows);
      expect(log).toContain("wrong_code");
      for (const secret of [made.ref, hash, state, RECIPIENT, "second@firm.example"]) { expect(all).not.toContain(secret); expect(log).not.toContain(secret); }
      expect(log).toContain(await hashOf(db, made.ref));
      expect(all).toContain("a***@firm.example");
      expect(all).not.toMatch(/code_hash|token_hash|"ref"|"code"/);
    });
  });
});

describe("BLOCK: expired still redeemable", () => {
  it("a code that is still valid does not keep an expired invite alive: verify, a new code and the page are all refused, nothing is used up, and the expiry is audited once", async () => {
    await inTx(async (db) => {
      const a = await company(db, "exp-code");
      const made = await create(db, a.admin);
      const hash = newHash();
      await issue(db, made.ref, hash);
      expect(await peek(db, made.ref)).not.toBeNull(); // the page was opened before the expiry
      await expireNow(db, made.id);
      // the code itself has not run out
      await db.query("UPDATE public.integration_connect_invites SET code_expires_at = now() + interval '10 minutes' WHERE id=$1", [made.id]);
      expect(await peek(db, made.ref)).toBeNull();
      const v = await verify(db, made.ref, hash);
      expect(v).toMatchObject({ ok: false, reason: "invalid" });
      expect(await refusalById(db, v.correlation_id)).toMatchObject([{ step: "verify", reason: "expired", organization_id: a.org }]);
      expect(await issue(db, made.ref)).toMatchObject({ ok: false, reason: "invalid" });
      expect(await states(db, made.id)).toBe(0);
      const r = await row(db, made.id);
      expect([r.used_at, r.code_hash]).toEqual([null, null]); // the stale code is wiped
      expect(await audit(db, a.org, "INTEGRATION_INVITE_EXPIRED")).toHaveLength(1);
    });
  });

  it("clock edge: an invite a minute from expiry hands out a code that never outlives it, and its state never outlives it either", async () => {
    await inTx(async (db) => {
      const a = await company(db, "exp-edge");
      const ref = newRef();
      const id = (await db.query(`INSERT INTO public.integration_connect_invites (organization_id, provider, ref, recipient_email, created_by, created_at, expires_at)
        VALUES ($1,'xero',$2,$3,$4, now() - interval '23 hours 59 minutes', now() + interval '1 minute') RETURNING id`, [a.org, ref, RECIPIENT, a.admin.id])).rows[0].id as string;
      const hash = newHash();
      expect(await issue(db, ref, hash)).toMatchObject({ ok: true });
      const r = await row(db, id);
      expect(Date.parse(String(r.code_expires_at))).toBeLessThanOrEqual(Date.parse(String(r.expires_at)));
      expect(await verify(db, ref, hash)).toMatchObject({ ok: true });
      const st = (await db.query("SELECT expires_at FROM public.integration_oauth_states WHERE via_invite=$1", [id])).rows[0];
      expect(Date.parse(String(st.expires_at))).toBeLessThanOrEqual(Date.parse(String(r.expires_at)));
    });
  });

  it("an expired invite can't be revoked into life or redeemed by any path: revoke says no, the old 107 functions don't exist", async () => {
    await inTx(async (db) => {
      const a = await company(db, "exp-revoke");
      const made = await create(db, a.admin);
      await expireNow(db, made.id);
      expect(ok(await as<{ r: boolean }>(db, a.admin, "SELECT public.integration_invite_revoke($1) AS r", [made.id]))[0].r).toBe(false);
      expect((await svc(db, "SELECT public.integration_invite_redeem($1,$2,$3)", [newHash(), newHash(), cipher()])).error).toMatchObject({ code: "42883" });
    });
  });

  it("the OAuth callback after expiry: verified before the expiry, called after it: refused, the state is used up, NO connection is stored, the refusal is traced", async () => {
    await inTx(async (db) => {
      const a = await company(db, "exp-callback");
      const made = await create(db, a.admin);
      const hash = newHash(), state = newHash();
      await issue(db, made.ref, hash);
      await verify(db, made.ref, hash, state);
      await expireNow(db, made.id);
      const c = ok(await svc<{ c: Json }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c;
      expect(c).toMatchObject({ ok: false, reason: "expired" });
      expect(c).not.toHaveProperty("verifier_enc");
      expect(c).not.toHaveProperty("organization_id");
      expect(await refusalById(db, c.correlation_id)).toMatchObject([{ step: "callback", reason: "expired", organization_id: a.org, ref_hash: await hashOf(db, made.ref) }]);
      // the state is gone either way: a second try finds nothing, and nothing was connected
      expect(ok(await svc<{ c: Json | null }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c).toBeNull();
      expect((await db.query("SELECT count(*)::int AS n FROM public.integration_connections WHERE organization_id=$1", [a.org])).rows[0].n).toBe(0);
    });
  });

  it("the OAuth callback also re-checks the company and the creating admin: demoted between the code and the callback means no connection", async () => {
    await inTx(async (db) => {
      const a = await company(db, "cb-demote");
      const made = await create(db, a.admin);
      const hash = newHash(), state = newHash();
      await issue(db, made.ref, hash);
      await verify(db, made.ref, hash, state);
      await db.query("UPDATE public.organization_members SET role='office' WHERE user_id=$1 AND organization_id=$2", [a.admin.id, a.org]);
      expect(ok(await svc<{ c: Json }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c).toMatchObject({ ok: false, reason: "creator_not_admin" });
    });
  });

  it("an unexpired invite still passes the callback check (the check does not refuse good use)", async () => {
    await inTx(async (db) => {
      const a = await company(db, "cb-good");
      const made = await create(db, a.admin);
      const hash = newHash(), state = newHash();
      await issue(db, made.ref, hash);
      await verify(db, made.ref, hash, state);
      expect(ok(await svc<{ c: Json }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c).toMatchObject({ organization_id: a.org, user_id: a.admin.id });
    });
  });
});

describe("BLOCK: forwarded link bypassing the recipient check", () => {
  it("no caller can pick or change the address: the code request takes no address, the table can't be written through the API, and the address in the answer is the bound one", async () => {
    await inTx(async (db) => {
      const a = await company(db, "fwd-bound");
      const made = await create(db, a.admin, "bound@firm.example");
      const args = (await db.query("SELECT proargnames FROM pg_proc WHERE oid = to_regprocedure('public.integration_invite_code_issue(text,text)')")).rows[0].proargnames as string[];
      expect(args).toEqual(["p_ref", "p_code_hash"]);
      for (const who of [a.admin, a.office, "anon" as const]) {
        expect((await as(db, who, "UPDATE public.integration_connect_invites SET recipient_email = 'attacker@evil.example'")).error).toMatchObject({ code: "42501" });
      }
      expect(await issue(db, made.ref)).toMatchObject({ ok: true, recipient: "bound@firm.example" });
      expect((await row(db, made.id)).recipient_email).toBe("bound@firm.example");
    });
  });

  it("whoever holds only the link (a forwardee) gets nowhere: no code can be verified before one is requested, guesses are counted and traced, and no state ever exists", async () => {
    await inTx(async (db) => {
      const a = await company(db, "fwd-guess");
      const made = await create(db, a.admin);
      // a forwardee can't make the code reach themselves, so they only guess: first without any code requested, then after the real recipient's request
      expect(await verify(db, made.ref, newHash())).toMatchObject({ ok: false, reason: "code_expired" });
      await issue(db, made.ref, newHash());
      const tries: Json[] = [];
      for (let n = 0; n < 5; n += 1) tries.push(await verify(db, made.ref, newHash()));
      expect(tries.map((t) => t.reason)).toEqual(["wrong_code", "wrong_code", "wrong_code", "wrong_code", "locked"]);
      expect(await states(db, made.id)).toBe(0);
      for (const t of tries) expect(await refusalById(db, t.correlation_id)).toHaveLength(1);
    });
  });

  it("a code issued for one invite does not open another invite to the same address", async () => {
    await inTx(async (db) => {
      const a = await company(db, "fwd-other");
      const one = await create(db, a.admin);
      const two = await create(db, a.admin);
      const h1 = newHash();
      await issue(db, one.ref, h1);
      await issue(db, two.ref, newHash());
      expect(await verify(db, two.ref, h1)).toMatchObject({ ok: false, reason: "wrong_code" });
    });
  });
});

describe("BLOCK: untraceable refusals", () => {
  it("every refusal path returns a correlation id that is a row of the security log: wrong code, locked, code expired, used, revoked, expired, unknown and malformed references, too many codes, wait", async () => {
    await inTx(async (db) => {
      const a = await company(db, "trace");
      const seen: Array<[string, Json]> = [];
      const m1 = await create(db, a.admin), m2 = await create(db, a.admin), m3 = await create(db, a.admin);
      const h = newHash();
      await issue(db, m1.ref, h);
      seen.push(["wait", await issue(db, m1.ref)]);
      seen.push(["wrong_code", await verify(db, m1.ref, newHash())]);
      await db.query("UPDATE public.integration_connect_invites SET code_expires_at = now() - interval '1 second' WHERE id=$1", [m1.id]);
      seen.push(["code_expired", await verify(db, m1.ref, h)]);
      await db.query("UPDATE public.integration_connect_invites SET code_expires_at = now() + interval '5 minutes' WHERE id=$1", [m1.id]);
      await verify(db, m1.ref, h); // used
      seen.push(["used", await verify(db, m1.ref, h)]);
      await as(db, a.admin, "SELECT public.integration_invite_revoke($1)", [m2.id]);
      seen.push(["revoked", await issue(db, m2.ref)]);
      await expireNow(db, m3.id);
      seen.push(["expired", await verify(db, m3.ref, newHash())]);
      seen.push(["unknown_ref", await verify(db, newRef(), newHash())]);
      seen.push(["malformed_ref", await issue(db, "short", newHash())]);
      const m4 = await create(db, a.admin);
      for (let n = 0; n < 5; n += 1) { await unthrottle(db, m4.id); await issue(db, m4.ref); }
      await unthrottle(db, m4.id);
      seen.push(["too_many_codes", await issue(db, m4.ref)]);
      for (const [reason, out] of seen) {
        expect(out.ok, reason).toBe(false);
        expect(out.correlation_id, reason).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        const logged = await refusalById(db, out.correlation_id);
        expect(logged, reason).toHaveLength(1);
        expect(logged[0].reason, reason).toBe(reason);
        expect(logged[0].ref_hash === null || /^[0-9a-f]{16}$/.test(logged[0].ref_hash!), reason).toBe(true);
      }
      // two refusals never share an id
      expect(new Set(seen.map(([, o]) => o.correlation_id)).size).toBe(seen.length);
    });
  });

  it("the refusal log keeps a hash of the reference only, and a company only for a matched invite", async () => {
    await inTx(async (db) => {
      const a = await company(db, "trace-hash");
      const made = await create(db, a.admin);
      const out = await verify(db, made.ref, newHash());
      const [r] = await refusalById(db, out.correlation_id);
      expect(r.ref_hash).toBe(await hashOf(db, made.ref));
      expect(r.organization_id).toBe(a.org);
      const all = JSON.stringify((await db.query("SELECT * FROM security_audit.integration_invite_refusals WHERE organization_id=$1", [a.org])).rows);
      expect(all).not.toContain(made.ref);
      const stranger = await verify(db, newRef(), newHash());
      expect((await refusalById(db, stranger.correlation_id))[0].organization_id).toBeNull();
    });
  });

  it("the app's own refusals (page for an invite not open, rate limit, callback state, bad origin): service role only, the reason for 'not_open' is worked out by the database, an unknown reason is 'other', an id given twice is one row", async () => {
    await inTx(async (db) => {
      const a = await company(db, "trace-app");
      const made = await create(db, a.admin);
      const log = async (step: string, reason: string, ref: string | null, id = randomUUID()) =>
        ok(await svc<{ r: string }>(db, "SELECT public.integration_invite_refusal_log($1,$2,$3,$4) AS r", [step, reason, ref, id]))[0].r;
      const open = await log("page", "not_open", made.ref);
      expect((await refusalById(db, open))[0]).toMatchObject({ reason: "creator_not_admin", organization_id: a.org }); // matched, but nothing marks why: its admin check
      await as(db, a.admin, "SELECT public.integration_invite_revoke($1)", [made.id]);
      const revoked = await log("page", "not_open", made.ref);
      expect((await refusalById(db, revoked))[0]).toMatchObject({ reason: "revoked", organization_id: a.org });
      expect((await refusalById(db, await log("page", "not_open", newRef())))[0]).toMatchObject({ reason: "unknown_ref", organization_id: null });
      expect((await refusalById(db, await log("page", "not_open", "nope")))[0]).toMatchObject({ reason: "malformed_ref", organization_id: null });
      expect((await refusalById(db, await log("request", "rate_limited", null)))[0]).toMatchObject({ reason: "rate_limited", ref_hash: null, organization_id: null });
      expect((await refusalById(db, await log("callback", "callback_state", null)))[0]).toMatchObject({ step: "callback", reason: "callback_state" });
      expect((await refusalById(db, await log("request", "bad_origin", made.ref)))[0]).toMatchObject({ reason: "bad_origin" });
      expect((await refusalById(db, await log("nonsense", "made_up_reason", null)))[0]).toMatchObject({ step: "page", reason: "other" });
      const same = randomUUID();
      await log("request", "rate_limited", null, same);
      await log("request", "rate_limited", null, same);
      expect(await refusalById(db, same)).toHaveLength(1);
      for (const who of [a.admin, a.office, "anon" as const]) {
        expect((await as(db, who, "SELECT public.integration_invite_refusal_log('page','other',null,null)")).error).toMatchObject({ code: "42501" });
      }
    });
  });

  it("nobody can read or write the refusal log through the API, not even the service role, and its writer can't be called", async () => {
    await inTx(async (db) => {
      const a = await company(db, "trace-grants");
      for (const who of [a.admin, a.office, "anon" as const]) {
        expect((await as(db, who, "SELECT count(*) FROM security_audit.integration_invite_refusals")).error, "select").toBeDefined();
        expect((await as(db, who, "DELETE FROM security_audit.integration_invite_refusals")).error, "delete").toBeDefined();
        expect((await as(db, who, "SELECT security_audit.integration_invite_refuse('page','other',null,null)")).error, "writer").toBeDefined();
      }
      expect((await svc(db, "SELECT count(*) FROM security_audit.integration_invite_refusals")).error).toBeDefined();
      expect((await svc(db, "INSERT INTO security_audit.integration_invite_refusals(step,reason) VALUES ('page','other')")).error).toBeDefined();
      expect((await svc(db, "SELECT security_audit.integration_invite_refuse('page','other',null,null)")).error).toBeDefined();
    });
  });
});

describe("concurrency: two redeems of one invite at the same moment", () => {
  it("exactly one wins, one state is kept", async () => {
    const co = await withDb(async (db) => committed(db, async () => {
      const c = await company(db, "race");
      const made = await create(db, c.admin);
      const hash = newHash();
      await issue(db, made.ref, hash);
      return { c, made, hash };
    }));
    const outcomes = await Promise.all([0, 1].map(() => withDb(async (db) => committed(db, async () => verify(db, co.made.ref, co.hash)))));
    expect(outcomes.filter((o) => o.ok === true)).toHaveLength(1);
    expect(outcomes.filter((o) => o.ok !== true)).toMatchObject([{ ok: false, reason: "invalid" }]);
    await withDb(async (db) => expect(await states(db, co.made.id)).toBe(1));
  });
});

describe("connecting through an invite is an ordinary connection: transfers stay OFF and held documents stay held (release 149)", () => {
  const hold = async (db: Db, org: string) => (await db.query("SELECT enabled FROM public.xero_transfer_hold WHERE organization_id=$1", [org])).rows[0]?.enabled as boolean | undefined;
  const claim = async (db: Db, org: string) => ok(await svc<{ r: { blocked: string | null; send: Json | null } }>(db, "SELECT public.integration_claim_next($1,'xero',120) AS r", [org]))[0].r;
  const queue = async (db: Db, org: string, ref: string) =>
    (await db.query("INSERT INTO public.integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) VALUES($1,'xero','invoice',$2,$3,'create') RETURNING id", [org, randomUUID(), ref])).rows[0].id as string;
  const sends = async (db: Db, org: string) => (await db.query("SELECT doc_ref, status, attempts, claim_token IS NOT NULL AS claimed FROM public.integration_sends WHERE organization_id=$1 ORDER BY doc_ref", [org])).rows;
  /** The whole invite path as the app drives it, ending where the callback does: consume the invite's state, store the connection as the invite's admin. */
  async function connectViaInvite(db: Db, co: Co, tenant = `tenant-${randomUUID()}`, externalId = randomUUID()) {
    const made = await create(db, co.admin);
    const hash = newHash(), state = newHash();
    await issue(db, made.ref, hash);
    await verify(db, made.ref, hash, state);
    const c = ok(await svc<{ c: { organization_id: string; user_id: string } }>(db, "SELECT public.integration_oauth_consume_invite('xero',$1) AS c", [state]))[0].c;
    ok(await svc(db, "SELECT public.integration_store_connection($1,$2,'xero',$3,'Synthetic Xero',$4,$5,$6,now()+interval '30 minutes',1)", [c.organization_id, c.user_id, tenant, externalId, cipher(), cipher()]));
    return made;
  }
  const mapAll = async (db: Db, admin: Actor) => {
    for (const sql of ["SELECT public.integration_set_mapping('xero','sales_account',null,'200','Sales')", "SELECT public.integration_set_mapping('xero','credit_account',null,'200','Sales')",
      "SELECT public.integration_set_mapping('xero','tax_rate','20','OUTPUT2','VAT 20')"]) ok(await as(db, admin, sql));
  };

  it("a company with a backlog connects through an invite: switch OFF, nothing claimed, every document pending and held; turning ON later still leaves that backlog held", async () => {
    await inTx(async (db) => {
      const co = await company(db, "held");
      await queue(db, co.org, "INV-151-A");
      await queue(db, co.org, "INV-151-B");
      const before = await sends(db, co.org);
      await connectViaInvite(db, co);
      expect(await hold(db, co.org)).toBe(false);
      expect(await claim(db, co.org)).toEqual({ blocked: "launch_hold", send: null });
      expect(await sends(db, co.org)).toEqual(before);
      const held = ok(await as<{ r: Array<{ doc_ref: string }> }>(db, co.admin, "SELECT public.integration_xero_held_sends() AS r"))[0].r;
      expect(held.map((h) => h.doc_ref).sort()).toEqual(["INV-151-A", "INV-151-B"]);
      await mapAll(db, co.admin);
      ok(await as(db, co.admin, "SELECT public.integration_xero_set_transfers(true)", [], { recent: 30 }));
      expect(await hold(db, co.org)).toBe(true);
      expect(await claim(db, co.org)).toEqual({ blocked: null, send: null });
      expect(await sends(db, co.org)).toEqual(before);
    });
  });

  it("a company that is already ON and connects again through an invite (a fresh consent, a later transaction): back OFF, and what was queued stays held", async () => {
    await withDb(async (db) => {
      const co = await committed(db, () => company(db, "reconsent"));
      const tenant = `tenant-${randomUUID()}`, external = randomUUID();
      await committed(db, async () => { await connectViaInvite(db, co, tenant, external); await mapAll(db, co.admin); });
      await committed(db, async () => {
        ok(await as(db, co.admin, "SELECT public.integration_xero_set_transfers(true)", [], { recent: 30 }));
        await queue(db, co.org, "INV-151-ON");
        expect(await hold(db, co.org)).toBe(true);
      });
      await committed(db, async () => {
        await db.query("SELECT pg_sleep(0.05)");
        await db.query("UPDATE public.integration_connect_invites SET revoked_at = now() WHERE organization_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [co.org]);
        await connectViaInvite(db, co, tenant, external);
      });
      await committed(db, async () => {
        expect(await hold(db, co.org)).toBe(false);
        expect(await claim(db, co.org)).toEqual({ blocked: "launch_hold", send: null });
        expect((await sends(db, co.org)).map((s) => [s.doc_ref, s.status, s.claimed])).toEqual([["INV-151-ON", "pending", false]]);
      });
    });
  });
});

describe("install and rollback", () => {
  it("installed over an open 107 token link: it is cancelled and audited, its functions are gone; a rollback refuses while a 151 invite is open, restores 107's functions, and the release installs again", async () => {
    await withDb(async (db) => {
      // back to 107's state (nothing of ours is open yet)
      await db.query("SET tolra.x151_accept_deleting_open_invites = 'yes'");
      await db.query(read(ROLLBACK));
      expect(await installed(db)).toBe(false);
      let old!: { org: string; id: string; token: string };
      try {
        await committed(db, async () => {
          const c = await company(db, "install");
          const token = newHash();
          const made = ok(await as<{ r: { id: string } }>(db, c.admin, "SELECT public.integration_invite_create('xero',$1) AS r", [token]))[0].r;
          old = { org: c.org, id: made.id, token };
        });
        await db.query(read(RELEASE));
        const r = (await db.query("SELECT revoked_at, revoke_reason, token_hash FROM public.integration_connect_invites WHERE id=$1", [old.id])).rows[0];
        expect(r.revoked_at).not.toBeNull();
        expect(r.revoke_reason).toBe("superseded_151");
        expect(r.token_hash).toBe(old.token);
        expect((await db.query("SELECT metadata FROM security_audit.audit_log WHERE organization_id=$1 AND action='INTEGRATION_INVITE_REVOKED' AND entity_table='integration_connect_invites'", [old.org])).rows[0].metadata).toMatchObject({ reason: "superseded_151", count: 1 });
        expect((await db.query("SELECT to_regprocedure('public.integration_invite_redeem(text,text,text)') AS a, to_regprocedure('public.integration_invite_create(text,text)') AS b")).rows[0]).toEqual({ a: null, b: null });
        // a second install is refused
        await expect(db.query(read(RELEASE))).rejects.toThrow(/applied before/);
        await db.query("ROLLBACK"); // the file's own BEGIN is left open by its refusal
        // a rollback refuses while an invite is open ...
        const open = await committed(db, async () => { const c = await company(db, "rollback"); return create(db, c.admin); });
        await db.query("RESET tolra.x151_accept_deleting_open_invites");
        await expect(db.query(read(ROLLBACK))).rejects.toThrow(/open connect invites exist/);
        await db.query("ROLLBACK");
        expect(await installed(db)).toBe(true);
        // ... and with it accepted, restores 107's shape, then the release goes in again
        await db.query("SET tolra.x151_accept_deleting_open_invites = 'yes'");
        await db.query(read(ROLLBACK));
        expect(await installed(db)).toBe(false);
        expect((await db.query("SELECT count(*)::int AS n FROM public.integration_connect_invites WHERE id=$1", [open.id])).rows[0].n).toBe(0);
        expect((await db.query("SELECT to_regprocedure('public.integration_invite_redeem(text,text,text)') AS a, to_regprocedure('public.integration_invite_create(text,text)') AS b")).rows[0].a).not.toBeNull();
      } catch (e) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        if (!(await installed(db))) await db.query(read(RELEASE));
        weInstalled = true;
      }
      const checks = (await db.query(read(VERIFY))).rows;
      expect(checks.filter((c) => c.ok !== true)).toEqual([]);
    });
  });
});
