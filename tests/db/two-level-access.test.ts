/**
 * Two-level access (migration 036), through the real API path: Supabase Auth + PostgREST with the anon key and a signed-in synthetic
 * user, exactly like the browser, so the database's own authorisation is what is under test (not the pages).
 *
 *   * Company users: a person holding companies A and B works in one at a time, chosen per sign-in session. A crafted choice of a
 *     company they hold no membership in is refused, whatever is written where; two sessions of one person stay apart.
 *   * Platform owner: lists every company, enters one with a reason and gets an expiring, read-only support membership; write access
 *     is a separate, logged, expiring elevation. Support can't create admins, change roles or extend its own expiry, doesn't count
 *     as an admin, and loses access the moment the window ends or a company admin revokes it.
 *   * The company entry log is written in the same transaction as the entry and can't be changed.
 *
 * The cross-company probes are the tenancy matrix's (tests/support/tenancy-tables.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generatePassword } from "@/lib/password";

import { isolatedBackend, SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { enrolTotp, passSecondStep } from "../support/totp";
import { TABLES, expectNoAccessTo, expectNoWrites, expectOnlyCompany, seedCompany } from "../support/tenancy-tables";
import { type SyntheticUser, type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, leftoverRows, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

type Person = SyntheticUser & { label: string };
type Seeded = Record<string, string>;

let world: SyntheticWorld;
let alpha: string;
let beta: string;
let gamma: string;
let seedA: Seeded;
let seedB: Seeded;
let seedC: Seeded;
let dual: Person; // admin of alpha and of beta, nothing in gamma
let owner: Person; // on the platform list; an ordinary viewer of alpha
let gammaAdmin: Person; // the only ordinary admin of gamma
let ownerFactor: { factorId: string; secret: string }; // the owner's authenticator app
const clients: SupabaseClient[] = [];

async function makePerson(label: string, runId: string): Promise<Person> {
  const email = `${label}.${runId}@example.test`;
  const password = generatePassword(16);
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${label[0].toUpperCase()}${label.slice(1)} Person` } });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  return { id: data.user.id, email, password, role: "admin", label };
}

async function client(person: Pick<SyntheticUser, "email" | "password">) {
  const c = await signedInClient(person);
  clients.push(c);
  return c;
}

/** A new sign-in session of the platform owner that has passed the second step (aal2); `client(owner)` alone is password-only (aal1). */
async function ownerClient() {
  const c = await client(owner);
  await passSecondStep(c, ownerFactor.factorId, ownerFactor.secret);
  await c.auth.refreshSession();
  return c;
}

async function tokenOf(c: SupabaseClient) {
  const { data } = await c.auth.getSession();
  const token = data.session!.access_token;
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { session_id: string; sub: string; aal?: string };
  return { token, sessionId: claims.session_id, userId: claims.sub, aal: claims.aal ?? "aal1" };
}

/** SQL as the signed-in person's session (role authenticated, their token's claims), in a transaction that is rolled back unless asked. */
async function asSession<T>(c: SupabaseClient, fn: (db: Client) => Promise<T>, commit = false): Promise<T> {
  const { sessionId, userId, aal } = await tokenOf(c);
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated", session_id: sessionId, aal })]);
      const result = await fn(db);
      await db.query(commit ? "commit" : "rollback");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const sql = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);
const currentOrg = async (c: SupabaseClient) => (await c.rpc("current_user_organization_id")).data as string | null;
const info = async (c: SupabaseClient) => (await c.rpc("my_session")).data as Record<string, unknown>;
/** Forgets the owner's support membership, selections and log rows in one company, so a test can start from "never entered". */
const forgetOwnerAt = async (org: string) => {
  await sql("delete from security_audit.session_company where user_id = $1", [owner.id]);
  await sql("delete from security_audit.org_entry_log where user_id = $1 and organization_id = $2", [owner.id, org]);
  await sql("delete from public.organization_members where user_id = $1 and organization_id = $2 and support", [owner.id, org]);
};
const logRows = (user: string, org: string) => sql<{ via: string; reason: string | null; write_access: boolean }>("select via, reason, write_access from security_audit.org_entry_log where user_id = $1 and organization_id = $2 order by at, id", [user, org]);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  alpha = world.tenants.alpha.id;
  beta = world.tenants.beta.id;
  const admin = adminClient();
  dual = await makePerson("dual", world.runId);
  owner = await makePerson("owner", world.runId);
  gammaAdmin = await makePerson("gamma-admin", world.runId);
  const created = await admin.rpc("create_organization", { p_name: `Gamma Test Engineering ${world.runId}`, p_slug: `${SYNTHETIC_SLUG_PREFIX}${world.runId}-gamma`, p_admin_email: gammaAdmin.email, p_company_profile: { documentName: "Gamma Test", addressLines: ["1 Test Road"], vatRegistered: false } });
  if (created.error || typeof created.data !== "string") throw new Error(`create gamma: ${created.error?.message}`);
  gamma = created.data;
  for (const org of [alpha, beta]) expect((await admin.rpc("add_member", { p_org: org, p_email: dual.email, p_role: "admin" })).data).toBe("member");
  expect((await admin.rpc("add_member", { p_org: alpha, p_email: owner.email, p_role: "viewer" })).data).toBe("member");
  // The platform owner list is written by the database owner only (the SQL editor): that is what this does.
  await sql("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner')", [owner.id]);
  // Platform owners always need the second step: enrol an authenticator once; every session then passes it.
  ownerFactor = await enrolTotp(await signedInClient(owner));
  seedA = await seedCompany(alpha, "a2");
  seedB = await seedCompany(beta, "b2");
  seedC = await seedCompany(gamma, "c2");
});

afterAll(async () => {
  if (!world) return;
  await destroySyntheticWorld(world.runId);
  expect(await leftoverRows(world.runId)).toEqual({});
});

describe("a company user: one company is chosen per sign-in session and enforced by the database", () => {
  it("a person with a single company goes straight in (no choice needed)", async () => {
    const c = await client(world.tenants.alpha.users.admin);
    expect(await currentOrg(c)).toBe(alpha);
    expect(await info(c)).toMatchObject({ organization_id: alpha, needs_choice: false, support: false, platform_admin: false, organization_count: 1 });
  });

  it("holding A and B but choosing neither: nothing resolves, every table refuses, the picker lists only their own companies", async () => {
    const c = await client(dual);
    expect(await currentOrg(c)).toBeNull();
    expect((await c.rpc("has_org_role", { allowed_roles: ["admin", "office", "workshop", "viewer"] })).data).toBe(false);
    expect(await info(c)).toMatchObject({ organization_id: null, needs_choice: true, organization_count: 2 });
    await expectNoAccessTo(c, alpha, seedA, "no choice: A");
    await expectNoAccessTo(c, beta, seedB, "no choice: B");
    const listed = (await c.rpc("my_organizations")).data as Array<{ organization_id: string; name: string }>;
    expect(listed.map((o) => o.organization_id).sort()).toEqual([alpha, beta].sort());
    // Third-party names never appear for them: not in the picker, not in the platform list.
    expect(JSON.stringify(listed)).not.toContain(world.runId + "-gamma");
    expect(JSON.stringify(listed)).not.toContain("Gamma Test");
    expect((await c.rpc("platform_list_organizations")).error).toMatchObject({ code: "42501" });
  });

  it("selected A: A's rows are readable, B's are neither readable nor writable in any table; switching to B flips it", async () => {
    const c = await client(dual);
    expect((await c.rpc("switch_organization", { p_org: alpha })).error).toBeNull();
    expect(await currentOrg(c)).toBe(alpha);
    await expectOnlyCompany(c, alpha, seedA, "selected A");
    await expectNoAccessTo(c, beta, seedB, "selected A, B");
    await expectNoAccessTo(c, gamma, seedC, "selected A, C");

    expect((await c.rpc("switch_organization", { p_org: beta })).error).toBeNull();
    expect(await currentOrg(c)).toBe(beta);
    await expectOnlyCompany(c, beta, seedB, "selected B");
    await expectNoAccessTo(c, alpha, seedA, "selected B, A");
    await expectNoAccessTo(c, gamma, seedC, "selected B, C");
    // The roles follow the chosen company, too.
    expect((await c.rpc("current_user_role")).data).toBe("admin");
  });

  it("a crafted selection of a company they hold no membership in is refused, and so is every way of writing one", async () => {
    const c = await client(dual);
    const { token, sessionId } = await tokenOf(c);
    expect((await c.rpc("switch_organization", { p_org: alpha })).error).toBeNull();
    // Through the RPC.
    expect((await c.rpc("switch_organization", { p_org: gamma })).error).toMatchObject({ code: "42501" });
    expect(await currentOrg(c)).toBe(alpha);
    // Straight at the table: not exposed, and no privilege either.
    const direct = await c.schema("security_audit" as never).from("session_company").insert({ session_id: sessionId, user_id: dual.id, organization_id: gamma });
    expect(direct.error).not.toBeNull();
    const { apiUrl, anonKey } = isolatedBackend();
    for (const url of [`${apiUrl}/rest/v1/session_company`, `${apiUrl}/rest/v1/org_entry_log`, `${apiUrl}/rest/v1/platform_admins`]) {
      const response = await fetch(url, { method: "POST", headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Profile": "security_audit" }, body: JSON.stringify({ organization_id: gamma }) });
      expect(response.ok).toBe(false);
    }
    // Raw REST reads of the company they asked for come back empty.
    const raw = await fetch(`${apiUrl}/rest/v1/customers?organization_id=eq.${gamma}&select=id`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } });
    expect(await raw.json()).toEqual([]);
    // Even a selection row forced into the table (by the database owner) for a company they don't hold is ignored on every call.
    await sql("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3) on conflict (session_id) do update set organization_id = excluded.organization_id", [sessionId, dual.id, gamma]);
    expect(await currentOrg(c)).toBeNull();
    await expectNoAccessTo(c, gamma, seedC, "forced selection, C");
    await expectNoAccessTo(c, alpha, seedA, "forced selection, A");
    expect((await logRows(dual.id, gamma))).toEqual([]);
  });

  it("a forced selection for a person with one company falls back to that company and never to the forced one", async () => {
    const solo = await client(world.tenants.alpha.users.admin);
    const { sessionId, userId } = await tokenOf(solo);
    await sql("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3) on conflict (session_id) do update set organization_id = excluded.organization_id", [sessionId, userId, beta]);
    expect(await currentOrg(solo)).toBe(alpha);
    await expectNoAccessTo(solo, beta, seedB, "forced B for an alpha user");
  });

  it("two sessions of the same person stay in different companies, and signing one out clears only its choice", async () => {
    const one = await client(dual);
    const two = await client(dual);
    expect((await one.rpc("switch_organization", { p_org: alpha })).error).toBeNull();
    expect((await two.rpc("switch_organization", { p_org: beta })).error).toBeNull();
    expect(await currentOrg(one)).toBe(alpha);
    expect(await currentOrg(two)).toBe(beta);
    await expectOnlyCompany(one, alpha, seedA, "session one");
    await expectOnlyCompany(two, beta, seedB, "session two");
    await expectNoAccessTo(one, beta, seedB, "session one, B");
    await expectNoAccessTo(two, alpha, seedA, "session two, A");
    // One moving does not move the other.
    expect((await one.rpc("switch_organization", { p_org: beta })).error).toBeNull();
    expect(await currentOrg(one)).toBe(beta);
    expect(await currentOrg(two)).toBe(beta);
    expect((await two.rpc("switch_organization", { p_org: alpha })).error).toBeNull();
    expect(await currentOrg(one)).toBe(beta);
    expect(await currentOrg(two)).toBe(alpha);

    const first = await tokenOf(one);
    const second = await tokenOf(two);
    const before = await sql<{ session_id: string }>("select session_id from security_audit.session_company where user_id = $1", [dual.id]);
    expect(before.map((r) => r.session_id)).toEqual(expect.arrayContaining([first.sessionId, second.sessionId]));
    // Signing out ends that session only; the selection goes with it.
    expect((await one.auth.signOut({ scope: "local" })).error).toBeNull();
    const after = await sql<{ session_id: string }>("select session_id from security_audit.session_company where user_id = $1", [dual.id]);
    expect(after.map((r) => r.session_id)).not.toContain(first.sessionId);
    expect(after.map((r) => r.session_id)).toContain(second.sessionId);
    expect(await currentOrg(two)).toBe(alpha);
  });

  it("access is checked on every call: a switched-off membership or a suspended company stops working at once", async () => {
    const person = await makePerson("flip", world.runId);
    const admin = adminClient();
    for (const org of [alpha, beta]) await admin.rpc("add_member", { p_org: org, p_email: person.email, p_role: "office" });
    const c = await client(person);
    expect((await c.rpc("switch_organization", { p_org: alpha })).error).toBeNull();
    expect(await currentOrg(c)).toBe(alpha);
    await sql("update public.organization_members set active = false where user_id = $1 and organization_id = $2", [person.id, alpha]);
    // Alpha is gone; beta is the only company left, so that is where this session lands.
    expect(await currentOrg(c)).toBe(beta);
    await expectNoAccessTo(c, alpha, seedA, "membership off");
    await sql("update public.organizations set status = 'paused' where id = $1", [beta]);
    try {
      expect(await currentOrg(c)).toBeNull();
    } finally {
      await sql("update public.organizations set status = 'active' where id = $1", [beta]);
    }
    expect(await currentOrg(c)).toBe(beta);
  });

  it("entries are logged: the first choice in a session, then each switch", async () => {
    const person = await makePerson("logged", world.runId);
    const admin = adminClient();
    for (const org of [alpha, beta]) await admin.rpc("add_member", { p_org: org, p_email: person.email, p_role: "viewer" });
    const c = await client(person);
    await c.rpc("switch_organization", { p_org: alpha });
    await c.rpc("switch_organization", { p_org: alpha }); // choosing the company already chosen is not a new entry
    await c.rpc("switch_organization", { p_org: beta });
    expect((await logRows(person.id, alpha)).map((r) => r.via)).toEqual(["login_choice"]);
    expect((await logRows(person.id, beta)).map((r) => r.via)).toEqual(["switch"]);
  });
});

describe("the platform owner", () => {
  it("is on the list only because the database owner put them there: nobody can add themselves", async () => {
    const c = await client(dual);
    expect((await c.rpc("is_platform_admin")).data).toBe(false);
    const { apiUrl, anonKey } = isolatedBackend();
    const { token } = await tokenOf(c);
    const response = await fetch(`${apiUrl}/rest/v1/platform_admins`, { method: "POST", headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Profile": "security_audit" }, body: JSON.stringify({ user_id: dual.id }) });
    expect(response.ok).toBe(false);
    // As each API role, in SQL: no privilege on the table at all (not even to read it), and no function writes it.
    for (const role of ["anon", "authenticated", "service_role"]) {
      await withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query(`set local role ${role}`);
          await expect(db.query("insert into security_audit.platform_admins (user_id) values ($1)", [dual.id])).rejects.toThrow(/permission denied/);
          await db.query("rollback");
          await db.query("begin");
          await db.query(`set local role ${role}`);
          await expect(db.query("select * from security_audit.platform_admins")).rejects.toThrow(/permission denied/);
        } finally {
          await db.query("rollback");
        }
      });
    }
    expect((await sql("select count(*)::int as n from security_audit.platform_admins where user_id = $1", [dual.id]))[0].n).toBe(0);
    // Being a company admin is not being on the list: the platform functions all refuse.
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "trying it on" })).error).toMatchObject({ code: "42501" });
    expect((await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "trying it on" })).error).toMatchObject({ code: "42501" });
    expect((await c.rpc("platform_exit_organization")).error).toMatchObject({ code: "42501" });
    expect(await sql("select 1 from public.organization_members where user_id = $1 and organization_id = $2", [dual.id, gamma])).toEqual([]);
    // No policy anywhere refers to it: the list grants no data by itself.
    expect(await sql("select policyname from pg_policies where coalesce(qual, '') ilike '%is_platform_admin%' or coalesce(with_check, '') ilike '%is_platform_admin%'")).toEqual([]);
  });

  it("must pick a company first: with none chosen they see nothing, even in the company they belong to", async () => {
    const c = await ownerClient();
    expect((await c.rpc("is_platform_admin")).data).toBe(true);
    expect(await currentOrg(c)).toBeNull();
    expect(await info(c)).toMatchObject({ organization_id: null, platform_admin: true, needs_choice: true });
    await expectNoAccessTo(c, alpha, seedA, "owner, nothing chosen");
    await expectNoAccessTo(c, gamma, seedC, "owner, nothing chosen, C");
    // Their own companies in the picker sense are only the ordinary memberships.
    expect(((await c.rpc("my_organizations")).data as Array<{ organization_id: string }>).map((o) => o.organization_id)).toEqual([alpha]);
    // The platform list shows every company.
    const all = (await c.rpc("platform_list_organizations")).data as Array<{ organization_id: string }>;
    expect(all.map((o) => o.organization_id)).toEqual(expect.arrayContaining([alpha, beta, gamma]));
  });

  it("entering needs a reason and a sensible length of time; the entry makes a support membership and a log row together", async () => {
    const c = await ownerClient();
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "" })).error).toMatchObject({ code: "22023" });
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "abc" })).error).toMatchObject({ code: "22023" });
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Looking at the year-end export", p_hours: 9 })).error).toMatchObject({ code: "22023" });
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Looking at the year-end export", p_hours: 0.1 })).error).toMatchObject({ code: "22023" });
    expect((await c.rpc("platform_enter_organization", { p_org: randomUUID(), p_reason: "Looking at the year-end export" })).error).toMatchObject({ code: "P0002" });
    expect(await sql("select 1 from public.organization_members where user_id = $1 and organization_id = $2", [owner.id, gamma])).toEqual([]);
    expect(await logRows(owner.id, gamma)).toEqual([]);

    const started = Date.now();
    const entered = await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Looking at the year-end export" });
    expect(entered.error).toBeNull();
    const expiresAt = new Date(entered.data.expires_at).getTime();
    expect(expiresAt - started).toBeGreaterThan(2 * 3600_000 - 60_000);
    expect(expiresAt - started).toBeLessThan(2 * 3600_000 + 60_000);
    expect(entered.data).toMatchObject({ organization_id: gamma, support: true, read_only: true });
    const [member] = await sql<{ role: string; support: boolean; active: boolean; support_reason: string }>("select role, support, active, support_reason from public.organization_members where user_id = $1 and organization_id = $2", [owner.id, gamma]);
    expect(member).toEqual({ role: "admin", support: true, active: true, support_reason: "Looking at the year-end export" });
    expect(await logRows(owner.id, gamma)).toEqual([{ via: "platform_support", reason: "Looking at the year-end export", write_access: false }]);
    expect(await currentOrg(c)).toBe(gamma);
    expect(await info(c)).toMatchObject({ organization_id: gamma, support: true, read_only: true, platform_admin: true });
    // The company's own admin sees it.
    const history = (await (await client(gammaAdmin)).rpc("org_entry_history")).data as Array<{ via: string; person: string; reason: string }>;
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ via: "platform_support", person: "Tolra support", reason: "Looking at the year-end export" })]));
    expect(JSON.stringify(history)).not.toContain("@");
  });

  it("support is read-only until elevated: it reads the whole company and writes nothing, in any table, definer function or bucket", async () => {
    const c = await ownerClient();
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Checking a customer's complaint" })).error).toBeNull();
    await expectOnlyCompany(c, gamma, seedC, "support, read-only");
    await expectNoWrites(c, gamma, seedC, "support, read-only");
    // Definer functions that write skip row-level security: the same rule stops them.
    expect((await c.rpc("next_doc_number", { p_prefix: "QUO" })).error).not.toBeNull();
    expect((await c.rpc("write_audit", { p_action: "UPDATE", p_entity_table: "jobs", p_entity_id: seedC.jobs, p_old: null, p_new: null, p_metadata: {}, p_ip: null, p_user_agent: null })).error).not.toBeNull();
    expect((await c.rpc("set_archive_state", { p_table: "jobs", p_id: seedC.jobs, p_state: "archived" })).error).not.toBeNull();
    // 117: a Problem is neither raised on the company's job nor cleared from a read-only support session.
    expect((await c.rpc("report_job_problem", { p_job: seedC.jobs, p_reason: "other", p_note: "Support attempt", p_request_id: randomUUID() })).error).not.toBeNull();
    expect((await c.rpc("resolve_job_problem", { p_problem: randomUUID(), p_note: "Support attempt" })).error).not.toBeNull();
    expect(await sql("select 1 from public.job_problems where organization_id = $1", [gamma])).toEqual([]);
    // 118: parts are not logged on the company's job from a read-only support session.
    expect((await c.rpc("log_job_parts", { p_job: seedC.jobs, p_quantity: 1, p_note: null, p_client_op_id: randomUUID() })).error).not.toBeNull();
    expect(await sql("select 1 from public.job_part_logs where organization_id = $1", [gamma])).toEqual([]);
    // Files.
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const upload = await c.storage.from("org-logos").upload(`${gamma}/support.png`, png, { contentType: "image/png", upsert: true });
    expect(upload.error).not.toBeNull();
    expect(await sql("select 1 from storage.objects where bucket_id = 'org-logos' and name = $1", [`${gamma}/support.png`])).toEqual([]);
    // The message says what to do about it.
    const refused = await c.from("customers").insert(TABLES.customers(gamma, "refused-message"));
    expect(refused.error?.message).toMatch(/read-only/i);
  });

  it("elevation is explicit, logged with a reason, expires, and never outlasts the support window", async () => {
    const c = await ownerClient();
    // Not before entering the company.
    expect((await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Fixing the customer's record" })).error).toMatchObject({ code: "42501" });
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Customer asked us to fix a record" })).error).toBeNull();
    expect((await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "" })).error).toMatchObject({ code: "22023" });
    expect((await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Fixing the customer's record", p_minutes: 500 })).error).toMatchObject({ code: "22023" });
    // Only for the company this session has entered.
    expect((await c.rpc("platform_elevate_support", { p_org: beta, p_reason: "Fixing the customer's record" })).error).toMatchObject({ code: "42501" });

    const elevated = await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Fixing the customer's record" });
    expect(elevated.error).toBeNull();
    expect(new Date(elevated.data.elevated_until).getTime() - Date.now()).toBeLessThan(31 * 60_000);
    expect(await info(c)).toMatchObject({ support: true, read_only: false });
    expect((await logRows(owner.id, gamma)).filter((r) => r.via === "platform_elevate")).toEqual([{ via: "platform_elevate", reason: "Fixing the customer's record", write_access: true }]);

    // Now it can write, to this company only.
    const row = await c.from("customers").insert(TABLES.customers(gamma, "support-wrote-this")).select("id, organization_id").single();
    expect(row.error).toBeNull();
    expect((await c.from("customers").insert(TABLES.customers(beta, "support-beta"))).error).not.toBeNull();
    expect((await c.from("customers").update({ name: "Renamed by support" }).eq("id", row.data!.id).select("id")).data).toHaveLength(1);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    expect((await c.storage.from("org-logos").upload(`${gamma}/support-elevated.png`, png, { contentType: "image/png", upsert: true })).error).toBeNull();
    await adminClient().storage.from("org-logos").remove([`${gamma}/support-elevated.png`]);
    // The change is recorded against the support session's person.
    const [audit] = await sql<{ n: number }>("select count(*)::int as n from security_audit.audit_log where organization_id = $1 and actor_user_id = $2", [gamma, owner.id]);
    expect(audit.n).toBeGreaterThan(0);

    // The elevation runs out by itself, at once, for this session.
    const { sessionId } = await tokenOf(c);
    await sql("update security_audit.session_company set elevated_until = now() - interval '1 second' where session_id = $1", [sessionId]);
    expect(await info(c)).toMatchObject({ support: true, read_only: true });
    expect((await c.from("customers").insert(TABLES.customers(gamma, "after-elevation"))).error).not.toBeNull();
    expect((await c.from("customers").select("id").eq("id", row.data!.id)).data).toHaveLength(1);

    // Never beyond the support window.
    await sql("update public.organization_members set expires_at = now() + interval '10 minutes' where user_id = $1 and organization_id = $2", [owner.id, gamma]);
    const capped = await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Fixing the customer's record", p_minutes: 120 });
    expect(capped.error).toBeNull();
    expect(new Date(capped.data.elevated_until).getTime()).toBe(new Date(capped.data.expires_at).getTime());
    expect(new Date(capped.data.elevated_until).getTime() - Date.now()).toBeLessThan(11 * 60_000);
  });

  it("expiry blocks at once, for a session that is already open; a new entry is needed; re-entering never extends the window", async () => {
    const c = await ownerClient();
    const entered = await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Looking into a login problem", p_hours: 1 });
    expect(entered.error).toBeNull();
    expect(await currentOrg(c)).toBe(gamma);
    expect((await c.from("customers").select("id").eq("id", seedC.customers)).data).toHaveLength(1);

    // Entering again while the window is open keeps the very same end time, whatever hours are asked for.
    const again = await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Looking again, for longer", p_hours: 8 });
    expect(again.error).toBeNull();
    expect(again.data.expires_at).toBe(entered.data.expires_at);

    await sql("update public.organization_members set expires_at = now() - interval '1 second' where user_id = $1 and organization_id = $2", [owner.id, gamma]);
    expect(await currentOrg(c)).toBeNull();
    expect((await info(c)).support).toBe(false);
    await expectNoAccessTo(c, gamma, seedC, "support expired");
    expect((await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Trying after it ended" })).error).toMatchObject({ code: "42501" });
    expect((await c.rpc("switch_organization", { p_org: gamma })).error).toMatchObject({ code: "42501" });
    // A new enter call opens a new window (and a new log row).
    const reopened = await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Back again with a new reason", p_hours: 1 });
    expect(reopened.error).toBeNull();
    expect(new Date(reopened.data.expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(await currentOrg(c)).toBe(gamma);
    expect((await logRows(owner.id, gamma)).filter((r) => r.via === "platform_support").length).toBeGreaterThanOrEqual(3);
  });

  it("the company's own admin can see support access and switch it off, and the open session loses access immediately", async () => {
    const c = await ownerClient();
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Setting up the import" })).error).toBeNull();
    const g = await client(gammaAdmin);
    expect(await currentOrg(g)).toBe(gamma);
    const members = (await g.rpc("org_members")).data as Array<{ user_id: string; support: boolean; expires_at: string | null; role: string }>;
    const support = members.find((m) => m.user_id === owner.id);
    expect(support).toMatchObject({ support: true, role: "admin" });
    expect(support?.expires_at).toBeTruthy();
    // They can't change what it is, or switch it back on; they can switch it off.
    for (const change of [{ p_role: "viewer" }, { p_hidden_sections: ["quotes"] }, { p_secondary_role: "office" }, { p_active: true }]) {
      expect((await g.rpc("set_member_access", { p_user: owner.id, ...change })).error).toMatchObject({ code: "42501" });
    }
    expect((await g.rpc("set_member_access", { p_user: owner.id, p_active: false })).error).toBeNull();
    expect(await currentOrg(c)).toBeNull();
    await expectNoAccessTo(c, gamma, seedC, "support revoked");
    expect((await g.rpc("org_members")).data.find((m: { user_id: string }) => m.user_id === owner.id)).toBeUndefined();
    // Re-entry is a new, logged enter call.
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Asked to come back by the customer" })).error).toBeNull();
    expect(await currentOrg(c)).toBe(gamma);
  });

  it("support can't create admins, change roles or extend its own expiry; it doesn't count as an admin", async () => {
    const c = await ownerClient();
    const entered = await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Reviewing who has access" });
    expect(entered.error).toBeNull();
    expect((await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Reviewing who has access" })).error).toBeNull();
    // Elevated, and still no say over who has access.
    for (const change of [{ p_user: gammaAdmin.id, p_role: "viewer" }, { p_user: gammaAdmin.id, p_active: false }, { p_user: owner.id, p_role: "admin" }, { p_user: owner.id, p_active: true }, { p_user: owner.id, p_hidden_sections: [] }]) {
      expect((await c.rpc("set_member_access", change)).error).toMatchObject({ code: "42501" });
    }
    // Direct writes to the membership table: no privilege.
    expect((await c.from("organization_members").update({ expires_at: "2099-01-01T00:00:00Z" }).eq("user_id", owner.id).select("user_id")).data ?? []).toHaveLength(0);
    expect((await c.from("organization_members").insert({ user_id: world.tenants.alpha.users.office.id, organization_id: gamma, role: "admin" })).error).not.toBeNull();
    expect((await c.from("organization_invites").insert({ organization_id: gamma, email: "new.admin@example.test", role: "admin" })).error).not.toBeNull();
    const [row] = await sql<{ expires_at: string }>("select expires_at from public.organization_members where user_id = $1 and organization_id = $2", [owner.id, gamma]);
    expect(new Date(row.expires_at).toISOString()).toBe(new Date(entered.data.expires_at).toISOString());
    expect(await sql("select 1 from public.organization_members where user_id = $1 and organization_id = $2", [world.tenants.alpha.users.office.id, gamma])).toEqual([]);
    // One more admin row (the support one) is not a second admin: the safeguard counts the company's own.
    const ordinaryAdmins = await sql("select 1 from public.organization_members where organization_id = $1 and active and not support and role = 'admin'", [gamma]);
    expect(ordinaryAdmins).toHaveLength(1);
    const g = await client(gammaAdmin);
    expect((await g.rpc("set_member_access", { p_user: gammaAdmin.id, p_role: "office" })).error).toMatchObject({ code: "23514" });
    expect((await g.rpc("set_member_access", { p_user: gammaAdmin.id, p_active: false })).error).toMatchObject({ code: "23514" });
    // Switching support off needs no other admin to be left, because support was never one.
    expect((await g.rpc("set_member_access", { p_user: owner.id, p_active: false })).error).toBeNull();
    expect(ordinaryAdmins).toHaveLength(1);
  });

  it("every platform function, and every company for the owner, needs the second step: password-only calls are refused, the code opens them", async () => {
    await forgetOwnerAt(gamma);
    const weak = await client(owner); // password only: aal1
    expect((await weak.rpc("platform_list_organizations")).error).toMatchObject({ code: "42501", hint: "mfa_required" });
    expect((await weak.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Password-only attempt" })).error).toMatchObject({ code: "42501", hint: "mfa_required" });
    expect((await weak.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Password-only attempt" })).error).toMatchObject({ code: "42501", hint: "mfa_required" });
    expect((await weak.rpc("platform_exit_organization")).error).toMatchObject({ code: "42501", hint: "mfa_required" });
    expect(await sql("select 1 from public.organization_members where user_id = $1 and organization_id = $2 and support", [owner.id, gamma])).toEqual([]);
    // Even their own company's data is closed to a platform owner on a password-only token.
    expect(await currentOrg(weak)).toBeNull();
    await expectNoAccessTo(weak, alpha, seedA, "owner at aal1");
    // The same session, after the second step, can do all of it.
    await passSecondStep(weak, ownerFactor.factorId, ownerFactor.secret);
    await weak.auth.refreshSession();
    expect((await weak.rpc("platform_list_organizations")).error).toBeNull();
    expect((await weak.rpc("platform_enter_organization", { p_org: gamma, p_reason: "After the second step" })).error).toBeNull();
    expect((await weak.rpc("platform_elevate_support", { p_org: gamma, p_reason: "After the second step" })).error).toBeNull();
    expect((await weak.rpc("platform_exit_organization")).error).toBeNull();
    // A support selection forced into a password-only session gives nothing either.
    const again = await client(owner);
    const { sessionId } = await tokenOf(again);
    await sql("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) select $1, $2, organization_id, support_grant from public.organization_members where user_id = $2 and organization_id = $3", [sessionId, owner.id, gamma]);
    expect(await currentOrg(again)).toBeNull();
    // Company users are not asked for it by these rules.
    expect(await currentOrg(await client(world.tenants.alpha.users.admin))).toBe(alpha);
  });

  it("a reopened grant gives an earlier session neither its selection nor its elevation back; the new grant works for the session that opened it", async () => {
    await forgetOwnerAt(gamma);
    const a = await ownerClient();
    const b = await ownerClient();
    expect((await a.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Session A looking into a problem" })).error).toBeNull();
    expect((await a.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Session A fixing the problem" })).error).toBeNull();
    expect(await currentOrg(a)).toBe(gamma);
    expect(await info(a)).toMatchObject({ support: true, read_only: false });
    expect((await a.from("customers").insert(TABLES.customers(gamma, "a-before-expiry"))).error).toBeNull();
    const grantOf = async () => (await sql<{ g: string }>("select support_grant as g from public.organization_members where user_id = $1 and organization_id = $2", [owner.id, gamma]))[0].g;

    for (const how of ["expires", "revoked"] as const) {
      if (how === "expires") await sql("update public.organization_members set expires_at = now() - interval '1 second' where user_id = $1 and organization_id = $2", [owner.id, gamma]);
      else await sql("update public.organization_members set active = false where user_id = $1 and organization_id = $2", [owner.id, gamma]);
      expect(await currentOrg(a)).toBeNull();
      const grantBefore = await grantOf();
      // Session B opens a new grant.
      expect((await b.rpc("platform_enter_organization", { p_org: gamma, p_reason: `Session B coming back (${how})` })).error).toBeNull();
      const grantAfter = await grantOf();
      expect(grantAfter).not.toBe(grantBefore);
      // B's new grant works, read-only until B elevates.
      expect(await currentOrg(b)).toBe(gamma);
      expect(await info(b)).toMatchObject({ support: true, read_only: true });
      expect((await b.from("customers").insert(TABLES.customers(gamma, `b-${how}`))).error).not.toBeNull();
      // A has neither the selection nor the elevation back: it is still shut out, in every table, and cannot write.
      expect(await currentOrg(a)).toBeNull();
      expect((await info(a)).support).toBe(false);
      await expectNoAccessTo(a, gamma, seedC, `session A after ${how}`);
      expect((await a.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Trying to use the old elevation" })).error).toMatchObject({ code: "42501" });
      // The old selection row still carries the old grant and elevation, and gives nothing.
      const [row] = await sql<{ elevated_until: string | null; grant_id: string }>("select elevated_until, grant_id from security_audit.session_company where session_id = $1", [(await tokenOf(a)).sessionId]);
      expect(row.grant_id).not.toBe(grantAfter);
      expect(row.elevated_until).not.toBeNull();
      // B elevates under the new grant and writes; A is untouched by that.
      expect((await b.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Session B fixing the problem" })).error).toBeNull();
      expect((await b.from("customers").insert(TABLES.customers(gamma, `b-written-${how}`))).error).toBeNull();
      expect((await a.from("customers").insert(TABLES.customers(gamma, `a-still-no-${how}`))).error).not.toBeNull();
      // A choosing the company again gets the new grant, read-only: the old elevation is not carried over. Choosing the same company
      // under a new grant is a new entry, logged in the same call (the earlier code logged only a change of company).
      const aSession = (await tokenOf(a)).sessionId;
      const entriesOfA = async () => sql<{ via: string; support_expires_at: string | null }>("select via, support_expires_at from security_audit.org_entry_log where session_id = $1 and organization_id = $2 order by at", [aSession, gamma]);
      const loggedBefore = (await entriesOfA()).length;
      expect((await a.rpc("switch_organization", { p_org: gamma })).error).toBeNull();
      const logged = await entriesOfA();
      expect(logged.length).toBe(loggedBefore + 1);
      expect(logged.at(-1)).toMatchObject({ via: "switch" });
      expect(logged.at(-1)!.support_expires_at).not.toBeNull();
      // Choosing it again under the same grant is not a new entry.
      expect((await a.rpc("switch_organization", { p_org: gamma })).error).toBeNull();
      expect((await entriesOfA()).length).toBe(loggedBefore + 1);
      expect(await info(a)).toMatchObject({ support: true, read_only: true });
      expect((await a.from("customers").insert(TABLES.customers(gamma, `a-after-${how}`))).error).not.toBeNull();
      // Put A back on a stale selection with a live-looking elevation for the next round.
      await sql("update security_audit.session_company set grant_id = gen_random_uuid(), elevated_until = now() + interval '1 hour' where session_id = $1", [(await tokenOf(a)).sessionId]);
    }
  });

  it("an ordinary membership of the owner is simply chosen (no support membership, no expiry), and the entry is logged", async () => {
    const c = await ownerClient();
    const entered = await c.rpc("platform_enter_organization", { p_org: alpha, p_reason: "Checking my own company's data" });
    expect(entered.error).toBeNull();
    expect(entered.data).toMatchObject({ support: false, read_only: false });
    const [member] = await sql<{ support: boolean; expires_at: string | null; role: string }>("select support, expires_at, role from public.organization_members where user_id = $1 and organization_id = $2", [owner.id, alpha]);
    expect(member).toEqual({ support: false, expires_at: null, role: "viewer" });
    expect(await currentOrg(c)).toBe(alpha);
    expect((await logRows(owner.id, alpha)).map((r) => r.via)).toContain("platform_member");
  });

  it("exiting clears the session's company and is logged; the next call needs a new entry", async () => {
    const c = await ownerClient();
    expect((await c.rpc("platform_enter_organization", { p_org: beta, p_reason: "A quick look at the schedule" })).error).toBeNull();
    expect(await currentOrg(c)).toBe(beta);
    expect((await c.rpc("platform_exit_organization")).error).toBeNull();
    expect(await currentOrg(c)).toBeNull();
    expect((await logRows(owner.id, beta)).map((r) => r.via)).toEqual(expect.arrayContaining(["platform_support", "platform_exit"]));
    await expectNoAccessTo(c, beta, seedB, "after exit");
  });

  it("a company the owner isn't in stays out of the ordinary picker lists", async () => {
    const c = await ownerClient();
    await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Looking for the missing delivery note" });
    const listed = (await c.rpc("my_organizations")).data as Array<{ organization_id: string }>;
    expect(listed.map((o) => o.organization_id)).toEqual([alpha]);
    // And a support membership never makes the person a member for the company's own lists.
    const g = await client(gammaAdmin);
    expect(((await g.rpc("my_organizations")).data as Array<{ organization_id: string }>).map((o) => o.organization_id)).toEqual([gamma]);
  });
});

describe("the entry log is written with the entry and can't be changed", () => {
  it("rolling the entry back leaves neither a support membership nor a log row", async () => {
    await forgetOwnerAt(gamma);
    const c = await ownerClient();
    const result = await asSession(c, async (db) => {
      await db.query("select public.platform_enter_organization($1, $2, 2)", [gamma, "Entry that is rolled back"]);
      // Inside the transaction the entry is in effect ...
      return (await db.query<{ org: string }>("select public.current_user_organization_id() as org")).rows[0].org;
    });
    expect(result).toBe(gamma);
    // ... and once it is rolled back there is nothing: no log row, no membership, no choice.
    expect(await logRows(owner.id, gamma)).toEqual([]);
    expect(await sql("select 1 from public.organization_members where user_id = $1 and organization_id = $2", [owner.id, gamma])).toEqual([]);
    expect(await currentOrg(c)).toBeNull();
  });

  it("if the log row can't be written the entry fails and nothing of it remains", async () => {
    await forgetOwnerAt(gamma);
    const c = await ownerClient();
    const name = `zz_fail_log_${Math.random().toString(16).slice(2, 8)}`;
    await sql(`create function security_audit.${name}() returns trigger language plpgsql as $$ begin raise exception 'injected log failure'; end $$`);
    await sql(`create trigger ${name} before insert on security_audit.org_entry_log for each row execute function security_audit.${name}()`);
    try {
      const entered = await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Entry whose log write fails" });
      expect(entered.error?.message).toContain("injected log failure");
      const elevated = await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Elevation whose log write fails" });
      expect(elevated.error).not.toBeNull();
    } finally {
      await sql(`drop trigger if exists ${name} on security_audit.org_entry_log`);
      await sql(`drop function if exists security_audit.${name}()`);
    }
    expect(await sql("select 1 from public.organization_members where user_id = $1 and organization_id = $2", [owner.id, gamma])).toEqual([]);
    expect(await sql("select 1 from security_audit.session_company where user_id = $1 and organization_id = $2", [owner.id, gamma])).toEqual([]);
    expect(await logRows(owner.id, gamma)).toEqual([]);
  });

  it("an elevation whose log write fails leaves the session read-only", async () => {
    await forgetOwnerAt(gamma);
    const c = await ownerClient();
    expect((await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Entry before a failing elevation" })).error).toBeNull();
    const name = `zz_fail_elev_${Math.random().toString(16).slice(2, 8)}`;
    await sql(`create function security_audit.${name}() returns trigger language plpgsql as $$ begin raise exception 'injected log failure'; end $$`);
    await sql(`create trigger ${name} before insert on security_audit.org_entry_log for each row when (new.via = 'platform_elevate') execute function security_audit.${name}()`);
    try {
      expect((await c.rpc("platform_elevate_support", { p_org: gamma, p_reason: "Elevation whose log write fails" })).error?.message).toContain("injected log failure");
    } finally {
      await sql(`drop trigger if exists ${name} on security_audit.org_entry_log`);
      await sql(`drop function if exists security_audit.${name}()`);
    }
    expect(await info(c)).toMatchObject({ support: true, read_only: true });
    expect((await c.from("customers").insert(TABLES.customers(gamma, "no-elevation"))).error).not.toBeNull();
  });

  it("is append-only: no update or delete, from any API role, and the table itself refuses even where a privilege is given", async () => {
    const c = await ownerClient();
    await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Making a row to try to change" });
    const [row] = await sql<{ id: string }>("select id from security_audit.org_entry_log where user_id = $1 order by at desc limit 1", [owner.id]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await withDb(async (db) => {
        for (const statement of ["update security_audit.org_entry_log set reason = 'changed' where id = $1", "delete from security_audit.org_entry_log where id = $1", "insert into security_audit.org_entry_log (organization_id, user_id, via, reason) select organization_id, user_id, via, 'copy' from security_audit.org_entry_log where id = $1"]) {
          await db.query("begin");
          try {
            await db.query(`set local role ${role}`);
            await expect(db.query(statement, [row.id])).rejects.toThrow(/permission denied/);
          } finally {
            await db.query("rollback");
          }
        }
      });
    }
    // The trigger is a second lock: give the API role every privilege and a policy inside a transaction and it still can't.
    for (const statement of ["update security_audit.org_entry_log set reason = 'changed' where id = $1", "delete from security_audit.org_entry_log where id = $1"]) {
      await withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query("grant select, update, delete on security_audit.org_entry_log to authenticated");
          await db.query("create policy zz_open on security_audit.org_entry_log for all to authenticated using (true) with check (true)");
          await db.query("set local role authenticated");
          await expect(db.query(statement, [row.id])).rejects.toThrow(/append-only/);
        } finally {
          await db.query("rollback");
        }
      });
    }
    expect((await sql<{ reason: string }>("select reason from security_audit.org_entry_log where id = $1", [row.id]))[0].reason).toBe("Making a row to try to change");
  });

  it("each company's admins read only the entries into their own company", async () => {
    const c = await ownerClient();
    await c.rpc("platform_enter_organization", { p_org: gamma, p_reason: "Entry into gamma only" });
    const mine = (await (await client(gammaAdmin)).rpc("org_entry_history")).data as Array<{ via: string; reason: string }>;
    expect(mine.some((r) => r.reason === "Entry into gamma only")).toBe(true);
    const theirs = (await (await client(world.tenants.alpha.users.admin)).rpc("org_entry_history")).data as Array<{ reason: string }>;
    expect(JSON.stringify(theirs)).not.toContain("Entry into gamma only");
    // Nobody else reads it: not a non-admin, not through the table.
    expect((await (await client(world.tenants.alpha.users.office)).rpc("org_entry_history")).error).toMatchObject({ code: "42501" });
    expect((await (await client(world.tenants.alpha.users.admin)).schema("security_audit" as never).from("org_entry_log").select("*")).error).not.toBeNull();
  });
});

describe("the catalogue", () => {
  it("every company table carries the read-only support trigger (so a table added later without it fails here)", async () => {
    const missing = await sql<{ t: string }>(`
      select c.table_schema || '.' || c.table_name as t
      from information_schema.columns c
      join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
      where c.column_name = 'organization_id' and c.table_schema in ('public', 'security_audit')
        and c.table_name not in ('user_profiles', 'organization_members', 'organization_invites', 'org_entry_log', 'session_company')
        and not exists (select 1 from pg_trigger t join pg_class k on k.oid = t.tgrelid join pg_namespace n on n.oid = k.relnamespace
                        where t.tgname = 'support_read_only' and not t.tgisinternal and n.nspname = c.table_schema and k.relname = c.table_name)
      order by 1`);
    expect(missing).toEqual([]);
  });

  it("the API roles hold no privilege on the access tables, and the helpers can't be bypassed through the resolver", async () => {
    const grants = await sql("select grantee, table_name from information_schema.role_table_grants where table_schema = 'security_audit' and table_name in ('platform_admins', 'session_company', 'org_entry_log') and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')");
    expect(grants).toEqual([]);
    const callable = await sql<{ r: string }>("select r.rolname as r from pg_roles r where r.rolname in ('anon', 'authenticated') and has_function_privilege(r.rolname, 'public._session_membership()', 'EXECUTE')");
    expect(callable).toEqual([]);
    const c = await client(dual);
    expect((await c.rpc("_session_membership")).error).not.toBeNull();
  });

  it("the verify script runs read-only and every fact it checks is true", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/two_level_access_036.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin transaction read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    expect(rows.filter((r) => r.n <= 9).map((r) => [r.n, r.value])).toEqual(Array.from({ length: 9 }, (_, i) => [i + 1, "true"]));
    expect(rows.filter((r) => r.n > 9 && r.n < 13).length).toBe(3);
    expect(rows.filter((r) => r.n === 13).map((r) => r.value)).toEqual(["true"]);
  });
});
