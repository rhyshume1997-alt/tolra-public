/**
 * Synthetic two-tenant fixtures for the isolated backend (audit B1).
 *
 * Two organisations ("alpha", "beta"), each with one user per role, created through the same service-role paths the
 * product uses (Auth admin API, create_organization, add_member). Every slug starts with SYNTHETIC_SLUG_PREFIX and
 * every e-mail ends in @example.test, so teardown can prove it removed exactly what it made.
 */
import { randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";

import { generatePassword } from "@/lib/password";

import { type IsolatedBackend, IsolationError, SYNTHETIC_SLUG_PREFIX, gitSha, isolatedBackend } from "./isolation";

export const ROLES = ["admin", "office", "workshop", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const TENANT_KEYS = ["alpha", "beta"] as const;
export type TenantKey = (typeof TENANT_KEYS)[number];

export type SyntheticUser = { id: string; email: string; password: string; role: Role };
export type SyntheticTenant = { key: TenantKey; id: string; slug: string; name: string; users: Record<Role, SyntheticUser> };
export type SyntheticWorld = { runId: string; tenants: Record<TenantKey, SyntheticTenant> };

export type BackendIdentity = {
  recordedAt: string;
  gitSha: string;
  apiUrl: string;
  database: { host: string; port: number; name: string; serverVersion: string };
  migrations: string[];
  organizations: number;
};

export const EMAIL_DOMAIN = "example.test";

export function newRunId() {
  return randomBytes(4).toString("hex");
}

/**
 * The local gateway (Kong 2.8) pools connections to PostgREST, and PostgREST (13.0.6) closes its side of a connection
 * after every HEAD response. Kong can hand that dead connection to the next request; a GET is retried, a POST (the rpc
 * calls these tests make) is not, and the caller gets Kong's 502 "An invalid response was received from the upstream
 * server" instead of the database's error. Count queries (`head: true`) are therefore sent as a one-row GET, which
 * returns the same count in Content-Range and leaves the connection reusable. Test support only.
 */
export const headAsGet: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method !== "HEAD") return fetch(request);
  const headers = new Headers(request.headers);
  headers.set("Range-Unit", "items");
  headers.set("Range", "0-0");
  const response = await fetch(request.url, { method: "GET", headers, signal: request.signal });
  await response.arrayBuffer();
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
};

export function adminClient(backend: IsolatedBackend = isolatedBackend()): SupabaseClient {
  return createClient(backend.apiUrl, backend.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: headAsGet } });
}

/** A browser-equivalent client (anon key) signed in as `user`. */
export async function signedInClient(user: Pick<SyntheticUser, "email" | "password">, backend: IsolatedBackend = isolatedBackend()) {
  const client = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: headAsGet } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`);
  return client;
}

export async function withDb<T>(fn: (db: Client) => Promise<T>, backend: IsolatedBackend = isolatedBackend()): Promise<T> {
  const db = new Client({ connectionString: backend.databaseUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/**
 * Proves which backend this run talks to, and that it is disposable: migrations table present, and every existing
 * organisation is synthetic. Throws an IsolationError otherwise, before anything is written.
 */
export async function verifyBackendIdentity(backend: IsolatedBackend = isolatedBackend()): Promise<BackendIdentity> {
  return withDb(async (db) => {
    const info = await db.query<{ name: string; version: string }>(
      "select current_database() as name, current_setting('server_version') as version",
    );
    const hasMigrations = await db.query("select to_regclass('supabase_migrations.schema_migrations') as t");
    if (!hasMigrations.rows[0].t) throw new IsolationError("the database has no supabase_migrations table (not a Supabase stack)");
    const migrations = await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations order by version");
    const foreign = await db.query<{ slug: string }>("select slug from public.organizations where slug not like $1 limit 3", [`${SYNTHETIC_SLUG_PREFIX}%`]);
    if (foreign.rows.length) {
      throw new IsolationError(`the database holds non-synthetic organisations (${foreign.rows.map((r) => r.slug).join(", ")}) so it is not disposable`);
    }
    const orgs = await db.query<{ n: string }>("select count(*)::text as n from public.organizations");
    return {
      recordedAt: new Date().toISOString(),
      gitSha: gitSha(),
      apiUrl: backend.apiUrl,
      database: { host: new URL(backend.databaseUrl).hostname, port: Number(new URL(backend.databaseUrl).port || 5432), name: info.rows[0].name, serverVersion: info.rows[0].version },
      migrations: migrations.rows.map((row) => row.version),
      organizations: Number(orgs.rows[0].n),
    };
  }, backend);
}

async function createUser(admin: SupabaseClient, email: string, password: string, fullName: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  return data.user.id;
}

/**
 * 083: ticks an admin as an authorised inspector (organization_members.can_inspect, a column migration 034 adds). The upgrade
 * rehearsal seeds its 013 base with createSyntheticWorld, before 034: there PostgREST answers PGRST204 (no such column) and the
 * tick is skipped once the database confirms the column is absent (083's backfill puts the admin on the list when the rehearsal
 * applies it). Any other error, or PGRST204 while the column exists (a stale schema cache), still throws.
 */
async function putAdminOnInspectorsList(admin: SupabaseClient, orgId: string, userId: string, what: string, backend: IsolatedBackend) {
  const { error } = await admin.from("organization_members").update({ can_inspect: true }).eq("organization_id", orgId).eq("user_id", userId);
  if (!error) return;
  if (error.code === "PGRST204") {
    const exists = await withDb(async (db) => (await db.query<{ v: boolean }>(
      "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organization_members' and column_name = 'can_inspect') as v")).rows[0].v, backend);
    if (!exists) return;
  }
  throw new Error(`${what}: ${error.message}`);
}

/** Creates both tenants and their eight users. Call verifyBackendIdentity first. */
export async function createSyntheticWorld(runId = newRunId(), backend: IsolatedBackend = isolatedBackend()): Promise<SyntheticWorld> {
  const admin = adminClient(backend);
  const tenants = {} as Record<TenantKey, SyntheticTenant>;
  for (const key of TENANT_KEYS) {
    const slug = `${SYNTHETIC_SLUG_PREFIX}${runId}-${key}`;
    const name = `${key === "alpha" ? "Alpha" : "Beta"} Test Engineering ${runId}`;
    const users = {} as Record<Role, SyntheticUser>;
    for (const role of ROLES) {
      const email = `${role}.${key}.${runId}@${EMAIL_DOMAIN}`;
      const password = generatePassword(16);
      users[role] = { id: await createUser(admin, email, password, `${role[0].toUpperCase()}${role.slice(1)} ${key}`), email, password, role };
    }
    // A complete company profile (documents refuse to issue without one). All values are synthetic.
    const profile = {
      documentName: name,
      addressLines: ["Unit 1, Test Estate", "Testtown", "TE1 1ST"],
      phone: "01000 000000",
      email: `office.${key}.${runId}@${EMAIL_DOMAIN}`,
      vatRegistered: true,
      vatNumber: "GB 000 0000 00",
      defaultVatRate: 20,
      brandedLogin: true,
      loginTagline: `Synthetic tenant ${runId}.`,
    };
    const { data: orgId, error } = await admin.rpc("create_organization", { p_name: name, p_slug: slug, p_admin_email: users.admin.email, p_company_profile: profile });
    if (error || typeof orgId !== "string") throw new Error(`create_organization ${slug}: ${error?.message}`);
    for (const role of ROLES.filter((r) => r !== "admin")) {
      const { data, error: addError } = await admin.rpc("add_member", { p_org: orgId, p_email: users[role].email, p_role: role });
      if (addError || data !== "member") throw new Error(`add_member ${role}@${slug}: ${addError?.message ?? data}`);
    }
    // 083: the company's admin is on the authorised inspectors list, as 083's backfill puts every existing admin (a test about an
    // admin who isn't takes them off). Harmless before 083, when an admin could always record inspections.
    await putAdminOnInspectorsList(admin, orgId, users.admin.id, `admin inspector ${slug}`, backend);
    tenants[key] = { key, id: orgId, slug, name, users };
  }
  return { runId, tenants };
}

/**
 * One extra company with a single admin, for a test that asserts something computed over the whole company (an average, a
 * total) and so must not share a company with other specs. The slug and the e-mail carry the run id, so teardown
 * (destroySyntheticWorld, leftoverRows) removes it with the rest of the run.
 */
export async function createSoloTenant(runId: string, label: string, backend: IsolatedBackend = isolatedBackend()) {
  const admin = adminClient(backend);
  const slug = `${SYNTHETIC_SLUG_PREFIX}${runId}-${label}`;
  const name = `Solo ${label} Test Engineering ${runId}`;
  const email = `admin.${label}.${runId}@${EMAIL_DOMAIN}`;
  const password = generatePassword(16);
  const id = await createUser(admin, email, password, `Admin ${label}`);
  const profile = {
    documentName: name,
    addressLines: ["Unit 1, Test Estate", "Testtown", "TE1 1ST"],
    phone: "01000 000000",
    email,
    vatRegistered: true,
    vatNumber: "GB 000 0000 00",
    defaultVatRate: 20,
    brandedLogin: false,
    loginTagline: `Synthetic tenant ${runId}.`,
  };
  const { data: orgId, error } = await admin.rpc("create_organization", { p_name: name, p_slug: slug, p_admin_email: email, p_company_profile: profile });
  if (error || typeof orgId !== "string") throw new Error(`create_organization ${slug}: ${error?.message}`);
  // 083: the solo admin is on the authorised inspectors list too, like each tenant's admin in createSyntheticWorld.
  await putAdminOnInspectorsList(admin, orgId, id, `solo admin inspector ${slug}`, backend);
  return { id: orgId as string, slug, name, admin: { id, email, password, role: "admin" as const } satisfies SyntheticUser };
}

/** Tables holding rows owned by an organisation (column organization_id), discovered from the catalogue. */
async function tenantTables(db: Client) {
  const { rows } = await db.query<{ schema: string; table: string }>(`
    select c.table_schema as schema, c.table_name as table
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.column_name = 'organization_id' and c.table_schema in ('public', 'security_audit')
    order by 1, 2`);
  return rows;
}

/** Row counts per table still owned by the run's organisations (empty object = clean). */
export async function leftoverRows(runId: string, backend: IsolatedBackend = isolatedBackend()) {
  return withDb(async (db) => {
    const prefix = `${SYNTHETIC_SLUG_PREFIX}${runId}-%`;
    const left: Record<string, number> = {};
    for (const { schema, table } of await tenantTables(db)) {
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from "${schema}"."${table}" where organization_id in (select id from public.organizations where slug like $1)`, [prefix]);
      if (Number(rows[0].n)) left[`${schema}.${table}`] = Number(rows[0].n);
    }
    const orgs = await db.query<{ n: string }>("select count(*)::text as n from public.organizations where slug like $1", [prefix]);
    if (Number(orgs.rows[0].n)) left["public.organizations"] = Number(orgs.rows[0].n);
    const users = await db.query<{ n: string }>("select count(*)::text as n from auth.users where email like $1", [`%.${runId}@${EMAIL_DOMAIN}`]);
    if (Number(users.rows[0].n)) left["auth.users"] = Number(users.rows[0].n);
    return left;
  }, backend);
}

/**
 * Removes everything the run created. Disposable database only: replica mode skips FK and audit triggers so rows
 * can go in any order. Refuses unless the backend still passes the isolation guard.
 */
export async function destroySyntheticWorld(runId: string, backend: IsolatedBackend = isolatedBackend()) {
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error(`not a synthetic run id: ${runId}`);
  await verifyBackendIdentity(backend);
  await withDb(async (db) => {
    const prefix = `${SYNTHETIC_SLUG_PREFIX}${runId}-%`;
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      const orgIds = (await db.query<{ id: string }>("select id from public.organizations where slug like $1", [prefix])).rows.map((r) => r.id);
      if (orgIds.length) {
        for (const { schema, table } of await tenantTables(db)) {
          await db.query(`delete from "${schema}"."${table}" where organization_id = any($1::uuid[])`, [orgIds]);
        }
        await db.query("delete from public.organizations where id = any($1::uuid[])", [orgIds]);
      }
      // Auth rows go with triggers back on, so their own cascades (identities, sessions) still run.
      await db.query("set local session_replication_role = origin");
      await db.query("delete from auth.users where email like $1", [`%.${runId}@${EMAIL_DOMAIN}`]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  }, backend);
}

/** Makes the alpha office and workshop users inspectors (migration 034: the flag is off by default; the admins are already, see createSyntheticWorld). */
export async function allowInspectors(world: SyntheticWorld, backend: IsolatedBackend = isolatedBackend()) {
  const { error } = await adminClient(backend).from("organization_members").update({ can_inspect: true })
    .eq("organization_id", world.tenants.alpha.id).in("user_id", [world.tenants.alpha.users.office.id, world.tenants.alpha.users.workshop.id]);
  if (error) throw new Error(error.message);
}

/**
 * Sets a company's database two-step rule (organizations.require_admin_mfa) for tests about what the rule DOES. Migration 065
 * refuses to turn it on while an admin has no verified authenticator factor; these synthetic admins have none, so this one
 * transaction runs in replica mode on the disposable database (ordinary triggers, including 065's guard, don't fire), as
 * destroySyntheticWorld does. Nothing in the migration offers a bypass. The enrolment check itself is proved in
 * admin-mfa-onboarding.test.ts and, with a real factor, admin-mfa.test.ts.
 */
export async function setRequireAdminMfaForTest(orgId: string, value: boolean, backend: IsolatedBackend = isolatedBackend()) {
  await withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query("update public.organizations set require_admin_mfa = $2 where id = $1", [orgId, value]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  }, backend);
}
