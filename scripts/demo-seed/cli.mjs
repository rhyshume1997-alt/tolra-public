#!/usr/bin/env node
/**
 * Fills a THROWAWAY or LOCAL database with the clearly fake "Tolra Demo" company, for screenshots (JOB U). Never run against a hosted project:
 * it requires a fresh database identity marker as well as loopback addresses and an explicit flag, and it is not wired into any deploy, CI job or migration.
 *
 *   scripts/test-backend.sh start        # local disposable Supabase, writes .env.test.local
 *   node scripts/demo-seed/cli.mjs --yes-this-is-a-throwaway-database
 *
 * See tests/DEMO-DATA.md.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { assertDisposableIdentity } from "./identity.mjs";

import { DEMO_ADMIN_EMAIL, DEMO_NAME, DEMO_SLUG, assertThrowaway, importPayload, planDemoData } from "./plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnv() {
  const env = { ...process.env };
  const file = path.join(ROOT, ".env.test.local");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  return env;
}

async function api(env, route, body) {
  const res = await fetch(`${env.TEST_SUPABASE_URL}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.TEST_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.TEST_SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000).toISOString();

async function main() {
  const env = loadEnv();
  assertThrowaway({ argv: process.argv.slice(2), env });
  const plan = planDemoData(new Date());
  const db = new pg.Client({ connectionString: env.TEST_DATABASE_URL });
  await db.connect();
  try {
    await assertDisposableIdentity(db, env.DEMO_DISPOSABLE_ID);
    const existing = await db.query("select id from public.organizations where slug = $1", [DEMO_SLUG]);
    if (existing.rowCount) throw new Error(`Refusing: a company with slug ${DEMO_SLUG} already exists in this database. Reset the local stack first (scripts/test-backend.sh reset).`);

    const password = randomBytes(12).toString("base64url");
    const user = await api(env, "/auth/v1/admin/users", { email: DEMO_ADMIN_EMAIL, password, email_confirm: true, user_metadata: { full_name: "Demo Admin" } });
    const orgId = await api(env, "/rest/v1/rpc/create_organization", { p_name: DEMO_NAME, p_slug: DEMO_SLUG, p_admin_email: DEMO_ADMIN_EMAIL, p_company_profile: plan.profile });

    // Act as the demo admin (authenticated, aal2), exactly like the app, in one transaction.
    const asAdmin = async (fn) => {
      await assertDisposableIdentity(db, env.DEMO_DISPOSABLE_ID);
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal2" })]);
        const out = await fn();
        await db.query("commit");
        return out;
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    };

    // Customers, invoices and payments go through the company's own data-import function (the rules that apply to real imports apply here).
    const imported = await asAdmin(async () => (await db.query("select public.import_company_data($1::jsonb, false, gen_random_uuid()) as r", [JSON.stringify(importPayload(plan))])).rows[0].r);
    if (!imported?.committed) throw new Error(`Import did not commit: ${JSON.stringify(imported).slice(0, 400)}`);

    const jobIds = {};
    for (const j of plan.jobs) {
      jobIds[j.job_no] = (await db.query("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, $3) returning id", [orgId, j.job_no, j.customer])).rows[0].id;
    }
    const machineIds = {};
    for (const m of plan.machines) {
      machineIds[m.name] = (await db.query("insert into public.machines (organization_id, name) values ($1, $2) returning id", [orgId, m.name])).rows[0].id;
    }

    // Machine and labour time through the same functions the Job Board uses, so activity-log entries come from the normal triggers.
    for (const t of plan.times) {
      await asAdmin(async () => {
        await db.query("select public.record_labour_event($1, $2, 'start', $3)", [randomUUID(), jobIds[t.job], hoursAgo(t.labourStartHoursAgo)]);
        await db.query("select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => $4, p_override => false, p_reason => null, p_bench => null)", [jobIds[t.job], [machineIds[t.machine]], randomUUID(), hoursAgo(t.runStartHoursAgo)]);
        await db.query("select public.pause_machine_run($1, null, $2, $3)", [jobIds[t.job], randomUUID(), hoursAgo(t.runStopHoursAgo)]);
        await db.query("select public.record_labour_event($1, $2, 'stop', $3)", [randomUUID(), jobIds[t.job], hoursAgo(t.labourStopHoursAgo)]);
      });
    }

    const counts = await db.query(
      `select (select count(*) from public.customers where organization_id = $1)::int as customers,
              (select count(*) from public.jobs where organization_id = $1)::int as jobs,
              (select count(*) from public.invoices where organization_id = $1)::int as invoices,
              (select count(*) from public.machine_runs where organization_id = $1)::int as machine_runs,
              (select count(*) from security_audit.audit_log where organization_id = $1)::int as activity_entries`, [orgId]);
    console.log(`Seeded "${DEMO_NAME}" (${DEMO_SLUG}) in the local database:`, JSON.stringify(counts.rows[0]));
    console.log(`Sign in as ${DEMO_ADMIN_EMAIL} with the one-time password: ${password}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
