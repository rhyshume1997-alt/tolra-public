#!/usr/bin/env node
/**
 * PQ environment CLI (called by tests/pq/setup.sh and reset.sh).
 *
 *   node tests/pq/seed/cli.mjs generate [--seed S] [--base-date YYYY-MM-DD] [--scale N]      JSON to stdout, no database
 *   node tests/pq/seed/cli.mjs identity  --yes-this-is-a-disposable-database                   guard only
 *   node tests/pq/seed/cli.mjs load      --yes-this-is-a-disposable-database [--auth sql|api] [...generate options]
 *   node tests/pq/seed/cli.mjs verify    --yes-this-is-a-disposable-database [...same options as load]
 *   node tests/pq/seed/cli.mjs reset     --yes-this-is-a-disposable-database
 *
 * Connection: TEST_DATABASE_URL (and for --auth api TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY), from the environment or
 * .env.test.local (written by scripts/test-backend.sh). Loopback only; see guard.mjs.
 * The ONLY use of the wall clock is the default for --base-date (today, UTC), and it is printed and recorded.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIRM_FLAG, PqIsolationError, assertConfirmed, backendFromEnv, verifyDisposableIdentity } from "./guard.mjs";
import { generatePqDataset } from "./generate.mjs";
import { loadPqDataset } from "./load.mjs";
import { pqLeftovers, resetPqData } from "./reset.mjs";
import { verifyLoaded } from "./verify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function option(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

export function readEnvFile(file = path.join(ROOT, ".env.test.local")) {
  const out = {};
  if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2]; }
  return out;
}

function datasetFromArgs(argv) {
  const baseDate = option(argv, "--base-date", new Date().toISOString().slice(0, 10)); // the one clock read; recorded in meta.baseDate
  return generatePqDataset({ seed: option(argv, "--seed", "pq-jnr-1"), baseDate, scale: Number(option(argv, "--scale", "1")) });
}

async function connect(env) {
  const pg = await import("pg");
  const Client = pg.Client ?? pg.default.Client;
  const backend = backendFromEnv(env);
  const db = new Client({ connectionString: backend.databaseUrl });
  await db.connect();
  return { db, backend };
}

function makeCreateUser(mode, db, backend, credentials) {
  if (mode === "api") {
    if (!backend.apiUrl || !backend.serviceRoleKey) throw new PqIsolationError("--auth api needs TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY (local stack only)");
    return async ({ email, fullName, role }) => {
      const password = `${randomBytes(9).toString("base64url")}aZ9`; // 12+ chars, letter and number; synthetic account on a disposable stack
      const res = await fetch(`${backend.apiUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}` },
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
      });
      const body = await res.json();
      if (!res.ok || !body.id) throw new Error(`Auth admin createUser ${email}: ${res.status} ${body.msg ?? body.message ?? ""}`);
      credentials.push({ email, role, password });
      return body.id;
    };
  }
  // sql: rows only (no password, no identity): enough for the database half and for acting-as in the loader; cannot sign in
  return async ({ email, fullName }) =>
    (await db.query("insert into auth.users (id, email, email_confirmed_at, aud, role, raw_user_meta_data) values (gen_random_uuid(), $1, now(), 'authenticated', 'authenticated', $2::jsonb) returning id",
      [email, JSON.stringify({ full_name: fullName })])).rows[0].id;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "generate") {
    process.stdout.write(`${JSON.stringify(datasetFromArgs(rest), null, 2)}\n`);
    return 0;
  }
  if (!["identity", "load", "verify", "reset"].includes(command)) {
    process.stderr.write("usage: cli.mjs generate|identity|load|verify|reset [options]\n");
    return 2;
  }
  assertConfirmed(rest);
  const env = { ...readEnvFile(), ...process.env };
  const { db, backend } = await connect(env);
  try {
    const identity = await verifyDisposableIdentity(db);
    process.stdout.write(`identity ok: database ${identity.database}, ${identity.migrations.length} migrations, ${identity.organizations} organisation(s), server ${identity.serverVersion}\n`);
    if (command === "identity") return 0;
    if (command === "reset") {
      const removed = await resetPqData(db);
      const left = await pqLeftovers(db);
      process.stdout.write(`reset: removed ${removed.runs} run(s), ${removed.organizations} organisation(s), ${removed.users} user(s); leftovers ${JSON.stringify(left)}\n`);
      return Object.keys(left).length ? 1 : 0;
    }
    const dataset = datasetFromArgs(rest);
    if (command === "load") {
      const existing = await db.query("select count(*)::int as n from public.organizations where slug = any($1)", [dataset.companies.map((c) => c.slug)]);
      if (existing.rows[0].n > 0) throw new PqIsolationError(`run ${dataset.meta.runId} is already loaded: run reset first (or pass another --seed)`);
      const credentials = [];
      let loaded;
      try {
        loaded = await loadPqDataset(db, dataset, { createUser: makeCreateUser(option(rest, "--auth", "sql"), db, backend, credentials), log: (l) => process.stdout.write(`${l}\n`) });
      } catch (error) {
        // all or nothing: take back the marker-tagged rows this attempt made, then report the original failure
        const undone = await resetPqData(db, { runId: dataset.meta.runId });
        process.stderr.write(`load failed; removed this run's partial data (${undone.organizations} organisation(s), ${undone.users} user(s))\n`);
        throw error;
      }
      for (const note of loaded.notes) process.stdout.write(`note: ${note}\n`);
      writeFileSync(path.join(ROOT, ".env.pq.run"), `PQ_SEED=${dataset.meta.seed}\nPQ_BASE_DATE=${dataset.meta.baseDate}\nPQ_SCALE=${dataset.meta.scale}\nPQ_RUN_ID=${dataset.meta.runId}\n`);
      if (credentials.length) {
        writeFileSync(path.join(ROOT, ".env.pq.credentials"), `${credentials.map((c) => `${c.role}\t${c.email}\t${c.password}`).join("\n")}\n`, { mode: 0o600 });
        process.stdout.write(`sign-in accounts written to .env.pq.credentials (git-ignored; synthetic accounts on this disposable stack only)\n`);
      }
      process.stdout.write(`loaded run ${dataset.meta.runId}: ${loaded.companies.map((c) => `${c.slug} (${Object.keys(c.users).length} users)`).join(", ")}\n`);
      return 0;
    }
    // verify
    const out = await verifyLoaded(db, dataset);
    for (const r of out.results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.actual)}`}\n`);
    process.stdout.write(`${out.results.filter((r) => r.ok).length}/${out.results.length} checks passed\n`);
    return out.ok ? 0 : 1;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode, not process.exit(): exiting at once truncates large output when stdout is a pipe (generate prints ~150 KB)
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof PqIsolationError ? 3 : 1;
  });
}
export { CONFIRM_FLAG };
