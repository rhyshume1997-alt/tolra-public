/**
 * Database half of the PQ environment, proved on a throw-away plain PostgreSQL 16 (no Docker, no Supabase CLI, no Auth API).
 *
 *   PQ_LOCAL_PG_URL=postgresql://postgres@127.0.0.1:55521/postgres  (a server you started yourself; needs psql on PATH or PQ_PG_BIN)
 *   npx vitest run -c tests/pq/vitest.config.ts tests/pq/pg-load.test.ts
 *
 * It builds its own database from supabase/migrations on a local shim (tests/pq/support), loads the seed with the real loader, runs the
 * real verify and reset, and drops the database afterwards. Without PQ_LOCAL_PG_URL every test here is skipped (and reported skipped).
 * What it cannot prove: Supabase Auth (sign-in, MFA), PostgREST/RLS through the API gateway, the browser.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertLoopbackUrl, verifyDisposableIdentity } from "./seed/guard.mjs";
import { generatePqDataset } from "./seed/generate.mjs";
import { loadPqDataset } from "./seed/load.mjs";
import { findPqRuns, pqLeftovers, resetPqData } from "./seed/reset.mjs";
import { verifyLoaded } from "./seed/verify.mjs";

const ROOT = path.resolve(__dirname, "../..");
const ADMIN_URL = process.env.PQ_LOCAL_PG_URL;
const BASE = "2026-11-02";
const DBNAME = `pq_vitest_${process.pid}`;

describe.skipIf(!ADMIN_URL)("PQ database half on a throw-away PostgreSQL 16", () => {
  let db: Client;
  let url: URL;
  const env = () => ({ ...process.env, PATH: `${process.env.PQ_PG_BIN ?? ""}:${process.env.PATH ?? ""}`, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username || "postgres") });
  const dbUrl = () => { const u = new URL(url.toString()); u.pathname = `/${DBNAME}`; return u.toString(); };
  const createUser = async ({ email, fullName }: { email: string; fullName: string }) =>
    (await db.query("insert into auth.users (id, email, email_confirmed_at, aud, role, raw_user_meta_data) values (gen_random_uuid(), $1, now(), 'authenticated', 'authenticated', $2::jsonb) returning id", [email, JSON.stringify({ full_name: fullName })])).rows[0].id as string;

  beforeAll(async () => {
    url = new URL(assertLoopbackUrl("PQ_LOCAL_PG_URL", ADMIN_URL));
    const built = spawnSync("bash", [path.join(ROOT, "tests/pq/support/build-local-pg.sh"), DBNAME], { env: env(), encoding: "utf8" });
    if (built.status !== 0) throw new Error(`build-local-pg.sh failed: ${built.stderr}${built.stdout}`);
    db = new Client({ connectionString: dbUrl() });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
    if (url) {
      const admin = new Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`drop database if exists ${DBNAME} with (force)`);
      await admin.end();
    }
    rmSync(path.join(ROOT, ".env.pq.run"), { force: true });
  });

  const asUser = async <T>(userId: string, fn: (q: Client["query"]) => Promise<T>) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
      return await fn(db.query.bind(db) as Client["query"]);
    } finally { await db.query("rollback"); }
  };

  it("the identity check passes on the empty built database and refuses once a real-looking company or user is present (rolled back each time)", async () => {
    const id = await verifyDisposableIdentity(db);
    expect(id.migrations.length).toBeGreaterThan(100);
    expect(id.organizations).toBe(0);
    // a real-looking company: refused. Inside a transaction that is rolled back, so the database is untouched.
    await db.query("begin");
    try {
      await createUser({ email: "real.person@example.test", fullName: "X" });
      await db.query("set local role service_role");
      await db.query("select public.create_organization('Acme Real Ltd', 'acme-real', 'real.person@example.test', $1::jsonb)", [JSON.stringify({ documentName: "Acme", vatRegistered: true, defaultVatRate: 20, addressLines: ["1"], phone: "0", email: "a@example.test" })]);
      await db.query("reset role");
      await expect(verifyDisposableIdentity(db)).rejects.toThrow(/non-synthetic organisations \(acme-real\)/);
    } finally { await db.query("rollback"); }
    // a real-looking auth user on its own: refused
    await db.query("begin");
    try {
      await db.query("insert into auth.users (id, email, aud, role) values (gen_random_uuid(), 'someone@gmail.com', 'authenticated', 'authenticated')");
      await expect(verifyDisposableIdentity(db)).rejects.toThrow(/1 auth user\(s\) outside @example\.test/);
    } finally { await db.query("rollback"); }
    await expect(verifyDisposableIdentity(db)).resolves.toBeTruthy();
  });

  it("loads the seed with the product's own functions; every database-side PQ check passes (counts and money to the penny)", async () => {
    // decoys the reset must leave alone: a slug that looks like ours with another name, and a user that is not ours
    await createUser({ email: "decoy.user@example.test", fullName: "Decoy" });
    const dsDecoy = await createUser({ email: "decoy.admin@example.test", fullName: "Decoy Admin" });
    await db.query("set role service_role");
    await db.query("select public.create_organization('Decoy Not A PQ Company', 't-aaaaaaaa-jnr', 'decoy.admin@example.test', $1::jsonb)", [JSON.stringify({ documentName: "Decoy", vatRegistered: true, defaultVatRate: 20, addressLines: ["1"], phone: "0", email: "d@example.test" })]);
    await db.query("reset role");
    void dsDecoy;

    const dataset = generatePqDataset({ baseDate: BASE, scale: 1 });
    const loaded = await loadPqDataset(db, dataset, { createUser });
    expect(loaded.companies.map((c) => c.slug)).toEqual([`t-${dataset.meta.runId}-jnr`, `t-${dataset.meta.runId}-practice`]);
    const out = await verifyLoaded(db, dataset);
    const failed = out.results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    expect(out.results.length).toBeGreaterThanOrEqual(50);
    expect(out.ok).toBe(true);
  });

  it("the loaded data is synthetic only: every auth user is on example.test, every customer is marked, every company is tagged", async () => {
    const users = await db.query("select email from auth.users");
    expect(users.rows.length).toBeGreaterThan(8);
    for (const r of users.rows) expect(r.email).toMatch(/@example\.test$/);
    const real = await db.query("select count(*)::int as n from public.customers where notes not like '%SYNTHETIC PQ DATA%' and organization_id in (select id from public.organizations where name like 'Synthetic %')");
    expect(real.rows[0].n).toBe(0);
    const orgs = await db.query("select slug, name from public.organizations where slug not like 't-aaaaaaaa-%' order by slug");
    expect(orgs.rows).toHaveLength(2);
    for (const o of orgs.rows) { expect(o.slug).toMatch(/^t-[0-9a-f]{8}-(jnr|practice)$/); expect(o.name).toMatch(/^Synthetic (JNR|Practice) PQ [0-9a-f]{8}$/); }
    await expect(verifyDisposableIdentity(db)).resolves.toBeTruthy(); // still disposable after loading
  });

  it("the database's own rules held for the seeded users: a viewer cannot write, the practice company cannot see JNR's records, numbers are per company", async () => {
    const dataset = generatePqDataset({ baseDate: BASE, scale: 1 });
    const users = await db.query("select id, email from auth.users where email like $1", [`%.${dataset.meta.runId}@example.test`]);
    const idOf = (prefix: string) => users.rows.find((r: { email: string }) => r.email.startsWith(prefix))!.id as string;
    const viewer = idOf("viewer1.jnr.");
    await expect(asUser(viewer, (q) => q("select public.create_job('Someone', 'viewer should fail', false, null, null, '[]'::jsonb, false, '[]'::jsonb, null)"))).rejects.toThrow(/Only admin, office or workshop staff can create jobs/);
    const practiceAdmin = idOf("admin1.practice.");
    // the practice company deliberately has customers with the same NAMES as JNR's first three; each sees only its own rows
    const practiceOrg = (await db.query("select id from public.organizations where slug = $1", [`t-${dataset.meta.runId}-practice`])).rows[0].id;
    const seen = await asUser(practiceAdmin, async (q) => ({
      all: (await q("select count(*)::int as n from public.customers")).rows[0].n,
      foreign: (await q("select count(*)::int as n from public.customers where organization_id <> $1", [practiceOrg])).rows[0].n,
      jobs: (await q("select count(*)::int as n from public.jobs where organization_id <> $1", [practiceOrg])).rows[0].n,
      invoices: (await q("select count(*)::int as n from public.invoices where organization_id <> $1", [practiceOrg])).rows[0].n,
    }));
    expect(seen).toEqual({ all: 3, foreign: 0, jobs: 0, invoices: 0 });
    const jnrAdmin = idOf("admin1.jnr.");
    const jnrSees = await asUser(jnrAdmin, async (q) => (await q("select count(*)::int as n from public.customers")).rows[0].n);
    expect(jnrSees).toBe(dataset.companies[0].customers.length);
    const refs = await db.query("select organization_id, min(invoice_ref) as first from public.invoices where invoice_ref is not null group by 1");
    expect(refs.rows.length).toBe(2);
    for (const r of refs.rows) expect(r.first).toBe("INV-0001");
  });

  it("reset removes everything the seeder made and nothing else, and a second reset removes nothing", async () => {
    const before = await db.query("select (select count(*) from public.organizations)::int as orgs, (select count(*) from auth.users)::int as users");
    expect((await findPqRuns(db)).size).toBe(1);
    const first = await resetPqData(db);
    expect(first).toEqual({ runs: 1, organizations: 2, users: 8 });
    expect(await pqLeftovers(db)).toEqual({});
    const after = await db.query("select (select count(*) from public.organizations)::int as orgs, (select count(*) from auth.users)::int as users");
    expect(after.rows[0]).toEqual({ orgs: before.rows[0].orgs - 2, users: before.rows[0].users - 8 });
    const decoy = await db.query("select name from public.organizations where slug = 't-aaaaaaaa-jnr'");
    expect(decoy.rows).toEqual([{ name: "Decoy Not A PQ Company" }]);
    expect((await db.query("select count(*)::int as n from auth.users where email in ('decoy.user@example.test', 'decoy.admin@example.test')")).rows[0].n).toBe(2);
    expect(await resetPqData(db)).toEqual({ runs: 0, organizations: 0, users: 0 });
    // tenant tables really are empty of the run: no row anywhere carries a PQ organisation, and no orphan audit rows remain
    const orphans = await db.query("select count(*)::int as n from security_audit.audit_log a where a.organization_id is not null and not exists (select 1 from public.organizations o where o.id = a.organization_id)");
    expect(orphans.rows[0].n).toBe(0);
  });

  it("can be loaded again after a reset (same seed), and a bigger --scale loads and verifies too", async () => {
    const d1 = generatePqDataset({ baseDate: BASE, scale: 1 });
    await loadPqDataset(db, d1, { createUser });
    expect((await verifyLoaded(db, d1)).ok).toBe(true);
    await resetPqData(db);
    const d5 = generatePqDataset({ baseDate: BASE, scale: 5, seed: "pq-volume" });
    await loadPqDataset(db, d5, { createUser });
    const out = await verifyLoaded(db, d5);
    expect(out.results.filter((r) => !r.ok)).toEqual([]);
    const counts = d5.expected.primary as Record<string, number>;
    expect(counts.invoices).toBeGreaterThan(100);
    expect(counts.attendanceEvents).toBeGreaterThan(300);
    await resetPqData(db);
    expect(await pqLeftovers(db)).toEqual({});
  });

  it("the command line does the same end to end: load, verify, load-again refused, reset (loopback URL, confirmation flag)", () => {
    const run = (command: string, extra: string[] = []) =>
      spawnSync("node", [path.join(ROOT, "tests/pq/seed/cli.mjs"), command, "--yes-this-is-a-disposable-database", "--base-date", BASE, "--seed", "pq-cli", ...extra],
        { cwd: ROOT, env: ({ PATH: process.env.PATH ?? "", HOME: "/tmp", TEST_DATABASE_URL: dbUrl() }) as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
    const load = run("load"); expect(load.stderr).toBe(""); expect(load.status).toBe(0); expect(load.stdout).toMatch(/loaded run [0-9a-f]{8}/);
    const verify = run("verify"); expect(verify.status).toBe(0); expect(verify.stdout).toMatch(/(\d+)\/\1 checks passed/);
    const again = run("load"); expect(again.status).toBe(3); expect(again.stderr).toMatch(/already loaded/);
    const reset = run("reset"); expect(reset.status).toBe(0); expect(reset.stdout).toMatch(/removed 1 run\(s\), 2 organisation\(s\), 8 user\(s\); leftovers \{\}/);
    const second = run("reset"); expect(second.stdout).toMatch(/removed 0 run\(s\)/);
  });

  it("a load that fails part-way is taken back by the CLI (all or nothing): nothing tagged is left", () => {
    // sabotage: a user the dataset wants to create already exists, so createUser's insert fails after the company's first rows
    const dataset = generatePqDataset({ baseDate: BASE, scale: 1, seed: "pq-fail" });
    const victim = dataset.companies[0].users[3].email;
    return db.query("insert into auth.users (id, email, aud, role) values (gen_random_uuid(), $1, 'authenticated', 'authenticated')", [victim]).then(async () => {
      const r = spawnSync("node", [path.join(ROOT, "tests/pq/seed/cli.mjs"), "load", "--yes-this-is-a-disposable-database", "--base-date", BASE, "--seed", "pq-fail"],
        { cwd: ROOT, env: ({ PATH: process.env.PATH ?? "", HOME: "/tmp", TEST_DATABASE_URL: dbUrl() }) as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/load failed; removed this run's partial data/);
      expect((await findPqRuns(db)).size).toBe(0);
      // the victim row is ours (test-made) and matches the PQ user pattern, so the CLI's cleanup removed it with the run
      expect(await pqLeftovers(db)).toEqual({});
    });
  });
});
