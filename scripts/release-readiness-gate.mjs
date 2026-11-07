#!/usr/bin/env node
// READ-ONLY production release readiness gate. Prints a per-check table and ONE overall line: "OVERALL: GO" or "OVERALL: NO GO".
// Any check that is missing, failed, skipped or unreadable is NO GO. Nothing is written: every statement must be a SELECT (refused
// otherwise) and runs inside a READ ONLY transaction that is always rolled back. A non-loopback database needs --production-readonly.
//
//   node scripts/release-readiness-gate.mjs --jnr-slug <slug> --cron-secret-length <n> --alert-email-set yes|no \
//        [--database-url <url> | DATABASE_URL] [--production-readonly] [--expect-mfa] [--fail-on-other-held] [--vercel-json <path>]
//
// Rhys approves any production run. Counts and names only: no secret, key or factor secret is selected.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIN_CRON_SECRET_LENGTH = 16;
export const REQUIRED_MARKERS = [
  { n: "138", re: /^marker 138\b/ }, { n: "140", re: /^marker 140\b/ }, { n: "141", re: /^marker 141\b/ }, { n: "143", re: /^marker 143\b/ }, { n: "144", re: /^marker 144\b/ },
  ...["145", "146", "147", "148", "149", "150", "151"].map((n) => ({ n, re: new RegExp(`^post-144 marker ${n}\\b`) })),
];
export const VERIFY_RELEASES = ["143", "144", "145", "146", "147", "148", "149", "150", "151"];
/** 073's invoice status allowlist plus the spellings the app also reads as void / cancelled. */
export const INVOICE_STATUS_ALLOWLIST = new Set(["draft", "issued", "sent", "partial", "paid", "credited", "void", "cancelled", "written_off", "voided", "canceled"]);
export const EXPECTED_CRONS = ["/api/cron/daily", "/api/cron/nightly"];

// ---------------------------------------------------------------- safety
const FORBIDDEN = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do|vacuum|analyze|reindex|cluster|comment|lock|listen|notify|prepare|execute|begin|commit|rollback|savepoint|set|reset|nextval|setval|set_config|dblink|lo_import|lo_export|pg_terminate_backend|pg_cancel_backend|pg_advisory_lock)\b/i;

/** The statement text with comments, string literals and quoted identifiers blanked, so keywords are only judged where they are code. */
function codeOnly(sql, bodies = []) {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const two = sql.slice(i, i + 2);
    if (two === "--") { const e = sql.indexOf("\n", i); i = e === -1 ? sql.length : e; out += " "; continue; }
    if (two === "/*") { const e = sql.indexOf("*/", i + 2); if (e === -1) throw new Error("Unterminated comment"); i = e + 2; out += " "; continue; }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("Unterminated quote");
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; }
        j++;
      }
      out += ch + ch; i = j + 1; continue;
    }
    const tag = ch === "$" ? /^\$[A-Za-z_]*\$/.exec(sql.slice(i)) : null;
    if (tag) {
      // A dollar-quoted body (the preflight runs inner queries through query_to_xml): judged on its own below, and must itself be a SELECT.
      const e = sql.indexOf(tag[0], i + tag[0].length);
      if (e === -1) throw new Error("Unterminated dollar quote");
      bodies.push(sql.slice(i + tag[0].length, e));
      out += "''"; i = e + tag[0].length; continue;
    }
    out += ch; i++;
  }
  return out;
}

/** Throws unless every statement in `sql` is a plain SELECT / WITH ... SELECT with no write, setting or lock keyword. Returns the statement count. */
export function assertSelectOnly(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new Error("Refused: empty statement");
  const bodies = [];
  const statements = codeOnly(sql, bodies).split(";").map((s) => s.trim()).filter(Boolean);
  if (!statements.length) throw new Error("Refused: no statement");
  for (const s of statements) {
    if (!/^(select|with)\b/i.test(s)) throw new Error(`Refused: only SELECT statements may run (got "${s.slice(0, 30)}")`);
    const hit = FORBIDDEN.exec(s);
    if (hit) throw new Error(`Refused: "${hit[1]}" is not allowed in a read-only statement`);
    if (/\binto\b/i.test(s)) throw new Error("Refused: SELECT ... INTO is not allowed");
    if (/\bfor\s+(no\s+key\s+)?(update|share)\b/i.test(s)) throw new Error("Refused: row locks are not allowed");
  }
  for (const body of bodies) assertSelectOnly(body);
  return statements.length;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
export function isLoopbackUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}
/** Refuses a non-loopback database unless --production-readonly was given. */
export function assertDatabaseUrlAllowed(url, { productionReadonly = false } = {}) {
  if (!url) throw new Error("Refused: no database URL (--database-url or DATABASE_URL)");
  if (isLoopbackUrl(url)) return "loopback";
  if (!productionReadonly) throw new Error("Refused: the database is not on loopback. Pass --production-readonly to read a non-local database (read-only transaction).");
  return "production-readonly";
}

// ---------------------------------------------------------------- arguments
export function parseArgs(argv) {
  const o = { productionReadonly: false, expectMfa: false, failOnOtherHeld: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`); return v; };
    if (a === "--production-readonly") o.productionReadonly = true;
    else if (a === "--expect-mfa") o.expectMfa = true;
    else if (a === "--fail-on-other-held") o.failOnOtherHeld = true;
    else if (a === "--database-url") o.databaseUrl = val();
    else if (a === "--jnr-slug") o.jnrSlug = val();
    else if (a === "--cron-secret-length") o.cronSecretLength = val();
    else if (a === "--alert-email-set") o.alertEmailSet = val();
    else if (a === "--vercel-json") o.vercelJson = val();
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------- decisions (pure)
const ok = (id, name, pass, detail) => ({ id, name, pass: pass === true, detail: String(detail) });
const readable = (r) => r && r.status === "ok" && Array.isArray(r.rows);
const unreadable = (id, name, r) => ok(id, name, false, `NOT CHECKED (${r?.status ?? "missing"}${r?.message ? `: ${r.message}` : ""})`);
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

function checkPreflight(r) {
  const name = "1a preflight markers 138/140/141/143/144 and 145-151 applied";
  if (!readable(r)) return unreadable("1a", name, r);
  const bad = [];
  for (const m of REQUIRED_MARKERS) {
    const row = r.rows.find((x) => m.re.test(String(x.check ?? "")));
    if (!row) bad.push(`${m.n} missing`);
    else if (row.value !== "applied") bad.push(`${m.n} ${row.value}`);
  }
  for (const x of r.rows) {
    const v = String(x.value ?? "");
    if ((v === "other" || v === "not applied") && !REQUIRED_MARKERS.some((m) => m.re.test(String(x.check)))) bad.push(`${String(x.check).slice(0, 40)} ${v}`);
  }
  return ok("1a", name, bad.length === 0, bad.length ? bad.join("; ") : `${REQUIRED_MARKERS.length} required markers applied`);
}

function checkVerify(map) {
  const name = "1b verify files 143-151 return all true";
  if (!map || typeof map !== "object") return unreadable("1b", name, undefined);
  const bad = [];
  for (const n of VERIFY_RELEASES) {
    const r = map[n];
    if (!r || r.status !== "ok" || !Array.isArray(r.sets)) { bad.push(`${n} ${r?.status ?? "missing"}${r?.message ? ` (${r.message})` : ""}`); continue; }
    if (r.sets.length === 0) { bad.push(`${n} no result`); continue; }
    for (const set of r.sets) {
      if (!set.length) { bad.push(`${n} empty result`); continue; }
      const boolCols = Object.keys(set[0]).filter((k) => set.some((row) => typeof row[k] === "boolean"));
      if (!boolCols.length) { bad.push(`${n} no true/false column`); continue; }
      for (const row of set) for (const k of boolCols) if (row[k] !== true) bad.push(`${n} ${String(Object.values(row)[0]).slice(0, 50)} = ${row[k]}`);
    }
  }
  return ok("1b", name, bad.length === 0, bad.length ? bad.slice(0, 8).join("; ") : `${VERIFY_RELEASES.length} files, all true`);
}

function checkDln(r, opts) {
  const name = "2 JNR delivery-note counter decided, none pending";
  if (!opts.jnrSlug) return ok("2", name, false, "NOT CHECKED (no --jnr-slug)");
  if (!readable(r)) return unreadable("2", name, r);
  const row = r.rows[0];
  if (!row) return ok("2", name, false, "no result row");
  const problems = [];
  if (num(row.org_found) !== 1) problems.push(`company "${opts.jnrSlug}" found ${row.org_found} times`);
  const set = num(row.counter_set), rel = num(row.hold_released), undone = num(row.counter_undone);
  if ([set, rel, undone].some(Number.isNaN)) problems.push("audit counts unreadable");
  else if (set + rel - undone !== 1) problems.push(`DLN_COUNTER_SET=${set} DLN_HOLD_RELEASED=${rel} DLN_COUNTER_UNDONE=${undone} (need exactly one in effect)`);
  if (num(row.jnr_pending) !== 0) problems.push(`dln_numbering_pending has ${row.jnr_pending} row(s) for ${opts.jnrSlug}`);
  const others = num(row.other_held_count);
  if (Number.isNaN(others)) problems.push("other held companies unreadable");
  else if (others > 0 && opts.failOnOtherHeld) problems.push(`other companies still held: ${row.other_held}`);
  const note = others > 0 ? ` (report: other held companies: ${row.other_held})` : "";
  return ok("2", name, problems.length === 0, problems.length ? problems.join("; ") + note : `counter decided once; JNR not pending${note}`);
}

function checkMfa(r, opts) {
  const name = "3 admin MFA readiness";
  if (!readable(r)) return unreadable("3", name, r);
  if (r.rows.length === 0) return ok("3", name, false, "no companies returned");
  const problems = [];
  const parts = [];
  for (const c of r.rows) {
    const admins = num(c.admins), withF = num(c.with_factor);
    if (Number.isNaN(admins) || Number.isNaN(withF)) { problems.push(`${c.company} counts unreadable`); continue; }
    parts.push(`${c.company}: admins ${admins}, with factor ${withF}, without ${admins - withF}, flag ${c.flag_on === true ? "on" : "off"}`);
    if (c.flag_on === true && withF < admins) problems.push(`${c.company}: ${admins - withF} admin(s) without a verified factor while the flag is on`);
    if (opts.expectMfa && c.flag_on !== true) problems.push(`${c.company}: require_admin_mfa is off but --expect-mfa was given`);
  }
  return ok("3", name, problems.length === 0, problems.length ? problems.join("; ") : parts.join(" | "));
}

function checkCron(vercel, opts) {
  const name = "4 cron configuration and env flags";
  const problems = [];
  const crons = Array.isArray(vercel?.crons) ? vercel.crons.map((c) => c?.path) : null;
  if (!crons) problems.push("vercel.json crons unreadable");
  else if (crons.length !== EXPECTED_CRONS.length || !EXPECTED_CRONS.every((p) => crons.includes(p))) problems.push(`vercel.json crons are [${crons.join(", ")}], need exactly [${EXPECTED_CRONS.join(", ")}]`);
  const len = opts.cronSecretLength === undefined ? NaN : Number(opts.cronSecretLength);
  if (opts.cronSecretLength === undefined) problems.push("--cron-secret-length not given");
  else if (!Number.isInteger(len) || len < MIN_CRON_SECRET_LENGTH) problems.push(`CRON_SECRET length ${opts.cronSecretLength} is below ${MIN_CRON_SECRET_LENGTH}`);
  if (opts.alertEmailSet === undefined) problems.push("--alert-email-set not given");
  else if (!["yes", "no"].includes(opts.alertEmailSet)) problems.push("--alert-email-set must be yes or no");
  else if (opts.alertEmailSet === "no") problems.push("ALERT_EMAIL_TO is not set: cron failures and missing migrations raise no alert");
  return ok("4", name, problems.length === 0, problems.length ? problems.join("; ") : `crons ${EXPECTED_CRONS.join(" + ")}; secret length ok; alert e-mail set`);
}

function checkXero(hold, sends) {
  const name = "5 Xero hold off, no sends stuck";
  if (!readable(hold)) return unreadable("5", name, hold);
  if (!readable(sends)) return unreadable("5", name, sends);
  const h = hold.rows[0], s = sends.rows[0];
  if (!h || !s) return ok("5", name, false, "no result row");
  const problems = [];
  if (num(h.hold_rows) !== num(h.companies) || Number.isNaN(num(h.companies))) problems.push(`hold rows ${h.hold_rows} for ${h.companies} companies`);
  if (num(h.held) !== 0) problems.push(`hold ON for ${h.held} company(ies): ${h.held_companies}`);
  if (num(s.needs_check) !== 0) problems.push(`${s.needs_check} send(s) in needs_check`);
  if (num(s.sending) !== 0) problems.push(`${s.sending} send(s) in sending`);
  return ok("5", name, problems.length === 0, problems.length ? problems.join("; ") : `${h.companies} companies, hold off; no needs_check or sending`);
}

function checkAi(control, flagged) {
  const name = "6 AI master switch off; cap-review flags listed";
  if (!readable(control)) return unreadable("6", name, control);
  if (!readable(flagged)) return unreadable("6", name, flagged);
  const c = control.rows[0];
  const problems = [];
  if (!c || num(c.rows) !== 1) problems.push(`ai_helper_tolra_control has ${c?.rows ?? "no"} row(s), need 1`);
  else if (num(c.enabled_rows) !== 0) problems.push("ai_helper_tolra_control.enabled is true");
  const list = flagged.rows.length ? flagged.rows.map((f) => `${f.company} @ ${f.flagged_at}`).join(", ") : "none";
  return ok("6", name, problems.length === 0, `${problems.length ? problems.join("; ") + "; " : ""}ai_cap_review_flagged: ${list}`);
}

function checkInvoices(r) {
  const name = "7 invoice statuses within the 073 allowlist";
  if (!readable(r)) return unreadable("7", name, r);
  const seen = r.rows.map((x) => String(x.status));
  const bad = seen.filter((s) => !INVOICE_STATUS_ALLOWLIST.has(s));
  return ok("7", name, bad.length === 0, bad.length ? `unexpected status: ${bad.join(", ")}; in use: ${seen.join(", ")}` : `in use: ${seen.length ? seen.join(", ") : "(no invoices)"}`);
}

function checkEmailLedger(r) {
  const name = "8 e-mail send ledger (106) present";
  if (!readable(r)) return unreadable("8", name, r);
  const row = r.rows[0];
  if (!row) return ok("8", name, false, "no result row");
  const missing = ["reserve_present", "complete_present"].filter((k) => row[k] !== true).map((k) => k.replace("_present", "_company_email"));
  return ok("8", name, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}; the send route refuses to send, so do not enable e-mail sending` : "reserve_company_email and complete_company_email present");
}

/** collected: { preflight, verify, dln, mfa, vercel, xero_hold, xero_sends, ai_control, ai_flagged, invoice_statuses }. Never throws: a check that blows up is a FAIL. */
export function decide(collected, opts = {}) {
  const c = collected ?? {};
  const run = (id, name, fn) => { try { return fn(); } catch (e) { return ok(id, name, false, `NOT CHECKED (${e instanceof Error ? e.message : "error"})`); } };
  const checks = [
    run("1a", "1a preflight markers", () => checkPreflight(c.preflight)),
    run("1b", "1b verify files", () => checkVerify(c.verify)),
    run("2", "2 JNR counter", () => checkDln(c.dln, opts)),
    run("3", "3 MFA", () => checkMfa(c.mfa, opts)),
    run("4", "4 cron", () => checkCron(c.vercel, opts)),
    run("5", "5 Xero", () => checkXero(c.xero_hold, c.xero_sends)),
    run("6", "6 AI", () => checkAi(c.ai_control, c.ai_flagged)),
    run("7", "7 invoices", () => checkInvoices(c.invoice_statuses)),
    run("8", "8 e-mail ledger", () => checkEmailLedger(c.email_ledger)),
  ];
  return { overall: checks.every((x) => x.pass) ? "GO" : "NO GO", checks };
}

export function formatReport(result) {
  const lines = ["check | result | detail", "----- | ------ | ------"];
  for (const k of result.checks) lines.push(`${k.name} | ${k.pass ? "PASS" : "FAIL"} | ${k.detail}`);
  lines.push(`OVERALL: ${result.overall}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- collection (database)
export function splitSections(text) {
  // split() with two capture groups returns [before, name, params, body, name, params, body, ...]
  const parts = text.split(/^-- @section (\w+)(?: params: (.*))?$/m);
  const result = {};
  for (let i = 1; i + 2 < parts.length; i += 3) result[parts[i]] = { params: (parts[i + 1] ?? "").trim(), sql: parts[i + 2] ?? "" };
  return result;
}

async function query(client, sql, params = []) {
  assertSelectOnly(sql);
  const res = await client.query(sql, params);
  return Array.isArray(res) ? res.map((r) => r.rows) : [res.rows];
}

async function guarded(client, label, fn) {
  await client.query("SAVEPOINT gate_check");
  try {
    const value = await fn();
    await client.query("RELEASE SAVEPOINT gate_check");
    return value;
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT gate_check").catch(() => undefined);
    return { status: "error", message: `${label}: ${e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : "failed"}` };
  }
}

export async function collect(client, opts) {
  const sections = splitSections(readFileSync(join(ROOT, "supabase/verify/release_readiness_gate.sql"), "utf8"));
  const collected = {};
  const section = async (key, params = []) => {
    const s = sections[key];
    if (!s) { collected[key] = { status: "missing", message: "section not in gate SQL" }; return; }
    collected[key] = await guarded(client, key, async () => ({ status: "ok", rows: (await query(client, s.sql, params))[0] ?? [] }));
  };
  collected.preflight = await guarded(client, "preflight", async () => ({ status: "ok", rows: (await query(client, readFileSync(join(ROOT, "supabase/verify/release_preflight.sql"), "utf8")))[0] ?? [] }));
  collected.verify = {};
  const dir = join(ROOT, "supabase/verify");
  const files = readdirSync(dir);
  for (const n of VERIFY_RELEASES) {
    const file = files.find((f) => f.endsWith(`_${n}.sql`));
    collected.verify[n] = !file ? { status: "missing", message: "verify file not found" } : await guarded(client, `verify ${n}`, async () => ({ status: "ok", sets: await query(client, readFileSync(join(dir, file), "utf8")) }));
  }
  await section("dln", [opts.jnrSlug ?? ""]);
  for (const key of ["mfa", "xero_hold", "xero_sends", "ai_control", "ai_flagged", "invoice_statuses", "email_ledger"]) await section(key);
  const vercelPath = opts.vercelJson ?? join(ROOT, "vercel.json");
  try { collected.vercel = JSON.parse(readFileSync(vercelPath, "utf8")); } catch { collected.vercel = null; }
  return collected;
}

export async function main(argv, env = process.env) {
  const opts = parseArgs(argv);
  const url = opts.databaseUrl ?? env.DATABASE_URL;
  assertDatabaseUrlAllowed(url, opts);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, statement_timeout: 60_000, application_name: "release-readiness-gate" });
  await client.connect();
  let collected;
  try {
    await client.query("BEGIN READ ONLY");
    collected = await collect(client, opts);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
  const result = decide(collected, opts);
  console.log(formatReport(result));
  return result.overall === "GO" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`Refused or failed: ${e instanceof Error ? e.message : "error"}`);
    console.log("OVERALL: NO GO");
    process.exit(1);
  });
}
