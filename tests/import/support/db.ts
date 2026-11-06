/**
 * Disposable-database helpers for the import rehearsal. pg only: no Docker, no Supabase CLI, no Auth API, no network beyond loopback.
 *
 * A test file asks for its own copy of the template database (CREATE DATABASE ... TEMPLATE, see support/build-template.sh), runs the
 * REAL importer (scripts/sliq-import: dry run, report, guards, write) against it, then inspects the result with plain SQL.
 * A missing server or template is a loud failure, never a skip and never a fallback to another database.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "pg";

import { checkDatabaseUrl } from "../../../scripts/sliq-import/guard.mjs";
import { dryRun, writeRun } from "../../../scripts/sliq-import/cli.mjs";
import { prepareRehearsal } from "../../../scripts/sliq-import/write.mjs";
import { assertLoopbackUrl } from "../../support/isolation";
import { buildScenario, writeExport, type Scenario } from "./synthetic";

export const MAPPING = path.resolve(__dirname, "rehearsal-mapping.json");
// Read when used, not at import, so the "missing database" tests can point them elsewhere.
const adminUrl = () => process.env.IMPORT_REHEARSAL_ADMIN_URL ?? "postgresql://postgres@127.0.0.1:55511/postgres";
const templateName = () => process.env.IMPORT_REHEARSAL_TEMPLATE ?? "sliq_rehearsal_tpl";

export class RehearsalDatabaseMissing extends Error {
  constructor(why: string) {
    super(
      `The SliQ import rehearsal needs its disposable PostgreSQL and template: ${why}\n` +
        "Start it:  tests/import/support/start-pg.sh   then build:  tests/import/support/build-template.sh\n" +
        "These tests never skip and never fall back to another database.",
    );
  }
}

export type Rehearsal = { url: string; name: string; drop: () => Promise<void> };

/** A fresh copy of the template named for this test file. Every URL is screened by the importer's own guard and the repo's loopback guard. */
export async function createRehearsalDb(label: string): Promise<Rehearsal> {
  const ADMIN_URL = assertLoopbackUrl("IMPORT_REHEARSAL_ADMIN_URL", adminUrl());
  const TEMPLATE = templateName();
  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    throw new RehearsalDatabaseMissing(`cannot connect to ${ADMIN_URL} (${(e as Error).message})`);
  }
  try {
    const has = await admin.query("select 1 from pg_database where datname = $1", [TEMPLATE]);
    if (has.rowCount === 0) throw new RehearsalDatabaseMissing(`template database ${TEMPLATE} does not exist`);
    if (!/^[a-z0-9_]+$/.test(label)) throw new Error("bad label");
    const name = `sliq_rehearsal_${label}_${randomBytes(3).toString("hex")}`;
    await admin.query(`create database ${name} template ${TEMPLATE}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    checkDatabaseUrl(url.toString()); // loopback and a "rehearsal" name, never a hosted or production-looking address
    return {
      url: url.toString(),
      name,
      drop: async () => {
        const a = new Client({ connectionString: ADMIN_URL });
        await a.connect();
        await a.query(`drop database if exists ${name} with (force)`);
        await a.end();
      },
    };
  } finally {
    await admin.end();
  }
}

export async function withClient<T>(url: string, fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** A synthetic company with one admin user (the same call the app's company set-up makes). Returns the organisation id. */
export async function makeOrg(url: string, slug: string): Promise<{ orgId: string; email: string; userId: string }> {
  return withClient(url, async (db) => {
    const email = `admin-${slug}@example.test`;
    const userId = randomUUID();
    await db.query("insert into auth.users(id,email,email_confirmed_at,aud,role) values ($1,$2,now(),'authenticated','authenticated')", [userId, email]);
    await db.query("set role service_role");
    const r = await db.query("select public.create_organization($1,$2,$3,$4::jsonb) as id", [
      `Synthetic ${slug}`,
      slug,
      email,
      JSON.stringify({ documentName: `Synthetic ${slug}`, vatRegistered: true, defaultVatRate: 20, addressLines: ["1 Test"], phone: "0", email }),
    ]);
    await db.query("reset role");
    const org = await db.query("select id from public.organizations where slug = $1", [slug]);
    void r;
    return { orgId: org.rows[0].id as string, email, userId };
  });
}

/** The company's own next number, taken as that company's admin would (public.next_doc_number is the app's only numbering path). */
export async function nextDocNumber(url: string, userId: string, prefix: string): Promise<string> {
  return withClient(url, async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [userId, JSON.stringify({ sub: userId, role: "authenticated" })]);
      const r = await db.query("select public.next_doc_number($1) as n", [prefix]);
      await db.query("commit");
      return r.rows[0].n as string;
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the importer is untyped .mjs: its report, plan and loaded records are plain JSON */
export type ImportRun = { dir: string; folder: string; report: any; plan: any; loaded: any; result: any; rehearsalId: string };
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The whole importer path on a disposable copy, exactly as the CLI does it: prepare the copy, dry run against it (read only, writes the
 * report), then write with every guard. Returns what the importer said, for the tests to compare with what the database now holds.
 */
export async function runImport(opts: { url: string; orgId: string; scenario?: Scenario; folder?: string; write?: boolean; excludeNumbers?: string[] }): Promise<ImportRun> {
  const dir = mkdtempSync(path.join(tmpdir(), "sliq-rehearsal-"));
  const scenario = opts.scenario ?? buildScenario();
  const excludeNumbers = opts.excludeNumbers ?? scenario.facts.operatorExcluded;
  const folder = opts.folder ?? writeExport(path.join(dir, "export"), scenario);
  const rehearsalId = (await prepareRehearsal(opts.url)) as string;
  const dry = await dryRun({ folder, outDir: path.join(dir, "report"), mapping: MAPPING, databaseUrl: opts.url, organizationId: opts.orgId, excludeNumbers });
  let result = null;
  if (opts.write !== false) {
    result = await writeRun({
      folder,
      reportPath: path.join(dir, "report", "report.json"),
      mapping: MAPPING,
      databaseUrl: opts.url,
      organizationId: opts.orgId,
      excludeNumbers,
      write: true,
      installImporter: true,
    });
  }
  return { dir, folder, report: dry.report, plan: dry.plan, loaded: dry.loaded, result, rehearsalId };
}
