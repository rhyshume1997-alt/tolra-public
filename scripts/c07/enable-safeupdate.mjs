// C07: install the pinned pg-safeupdate build (scripts/c07/build-safeupdate.sh) into the runner-owned disposable Supabase
// database container, make it the library every new session resolves, preload it for the importer's direct role, and prove it
// with the real library: the file the loader resolves 'safeupdate' to (bytes read as the server's own OS user), a 1.7-only
// behaviour that the image's 1.4 lacks, SHOW session_preload_libraries, and the real errors of a bare UPDATE and DELETE. No
// /proc reads: the container refuses them (run 41881288737). Every step that fails throws; nothing is skipped.
//
//   node scripts/c07/enable-safeupdate.mjs <dir with safeupdate.so + BUILD-INFO> <evidence dir> <file for the superuser URL>
//
// Local disposable stack only: the database URL must be loopback and the container is the one scripts/test-backend.sh started
// for supabase/config.toml's project_id. The superuser URL file is written outside the evidence directory (never uploaded).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const [builtDir, evidenceDir, superuserUrlFile] = process.argv.slice(2);
assert(builtDir && evidenceDir && superuserUrlFile, "usage: enable-safeupdate.mjs <built dir> <evidence dir> <superuser url file>");

const PROJECT = "tolra-local-test";
const DB_CONTAINER = `supabase_db_${PROJECT}`;
const REST_CONTAINER = `supabase_rest_${PROJECT}`;
const LIB_DIR = "/usr/local/lib/c07-safeupdate";
const LIB = `${LIB_DIR}/safeupdate.so`;
const SUPERUSER = "c07_direct_superuser";

const env = Object.fromEntries(readFileSync(".env.test.local", "utf8").split("\n").filter((s) => /^TEST_[A-Z_]+=/.test(s)).map((s) => {
  const i = s.indexOf("=");
  return [s.slice(0, i), s.slice(i + 1)];
}));
const dbUrl = new URL(env.TEST_DATABASE_URL);
const apiUrl = new URL(env.TEST_SUPABASE_URL);
assert(["localhost", "127.0.0.1"].includes(dbUrl.hostname) && dbUrl.pathname === "/postgres", "C07: fresh local postgres only");
assert(["localhost", "127.0.0.1"].includes(apiUrl.hostname), "C07: local API only");
assert.equal(decodeURIComponent(dbUrl.username), "postgres", "C07: expected the stack's own postgres role in TEST_DATABASE_URL");

const evidence = {};
const log = (label, value) => {
  evidence[label] = value;
  console.log(`C07 ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};
const docker = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", ...opts });
/** One statement as the container's bootstrap superuser (supabase_admin) over the container's own loopback. */
const admin = (sql) => docker(["exec", "-e", `PGPASSWORD=${decodeURIComponent(dbUrl.password)}`, DB_CONTAINER,
  "psql", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-A", "-t", "-q", "-c", sql]).trim();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const uniq = (xs) => [...new Set(xs)];
async function client(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
/** The real error text of a statement, or null when it succeeds. */
async function errorOf(c, sql) {
  try {
    await c.query(sql);
    return null;
  } catch (e) {
    return e.message;
  }
}

// 1. The pinned build.
const info = Object.fromEntries(readFileSync(path.join(builtDir, "BUILD-INFO"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
assert.equal(info.commit, "37dbc9c4acf5e2504adf2b218e9c6b41751022f3", "C07: build is not the pinned commit");
assert.equal(info.version, "1.7", "C07: build is not version 1.7");
assert.equal(sha256(path.join(builtDir, "safeupdate.so")), info.library_sha256, "C07: built library changed after the build");
log("pinned build", info);

// 2. What the Supabase image itself ships (recorded, not used: the pinned build is the one every session resolves below).
log("server version", admin("select version()"));
const pkglibdir = admin("select setting from pg_config where name = 'PKGLIBDIR'");
log("image $libdir", pkglibdir);
try {
  log("image safeupdate", docker(["exec", DB_CONTAINER, "sh", "-c", 'ls -l "$1/safeupdate.so" && readlink -f "$1/safeupdate.so"', "sh", pkglibdir]).trim());
} catch (e) {
  log("image safeupdate", `not readable: ${String(e.stderr || e.message).trim()}`);
}
log("dynamic_library_path before", admin("show dynamic_library_path"));

// 3. Install the pinned build into the container and check the bytes that arrived.
docker(["exec", "-u", "root", DB_CONTAINER, "mkdir", "-p", LIB_DIR]);
docker(["cp", path.join(builtDir, "safeupdate.so"), `${DB_CONTAINER}:${LIB}`]);
docker(["exec", "-u", "root", DB_CONTAINER, "chmod", "0755", LIB]);
const back = path.join(mkdtempSync(path.join(tmpdir(), "c07-lib-")), "safeupdate.so");
docker(["cp", `${DB_CONTAINER}:${LIB}`, back]);
assert.equal(sha256(back), info.library_sha256, "C07: the library in the container is not the pinned build");
// The bytes as the server's own OS user reads them (the owner of the data directory, by number: no passwd lookup needed).
const dataDir = admin("show data_directory");
const serverUid = docker(["exec", "-u", "root", DB_CONTAINER, "ls", "-ldn", dataDir]).trim().split(/\s+/)[2];
assert.match(serverUid, /^[0-9]+$/, "C07: cannot tell the server's OS user");
const asServer = createHash("sha256").update(docker(["exec", "-u", serverUid, DB_CONTAINER, "cat", LIB], { encoding: "buffer" })).digest("hex");
assert.equal(asServer, info.library_sha256, "C07: the server's OS user does not read the pinned build at the installed path");
log("installed library", { path: LIB, sha256: info.library_sha256, read_as_server_uid: serverUid,
  listing: docker(["exec", "-u", "root", DB_CONTAINER, "ls", "-ln", LIB]).trim() });

// 4. Every new session resolves 'safeupdate' to the pinned build first ($libdir after it for everything else); the importer's
//    direct role (postgres, as scripts/sliq-import connects) preloads it in every new session, keeping any preload it had.
admin(`alter system set dynamic_library_path = '${LIB_DIR}:$libdir'`);
admin("select pg_reload_conf()");
// What a new postgres session preloads today (role-in-database, role, database setting, else the server's own value), read as the
// administrator: SHOW session_preload_libraries needs pg_read_all_settings, which the postgres role may not have.
const override = (role, db) => admin(`select coalesce((select substr(c, 27) from pg_db_role_setting s, unnest(s.setconfig) c
  where s.setrole = ${role} and s.setdatabase = ${db} and c like 'session_preload_libraries=%'), '<none>')`);
const pgRole = "'postgres'::regrole";
const pgDb = "(select oid from pg_database where datname = 'postgres')";
let current = [override(pgRole, pgDb), override(pgRole, "0"), override("0", pgDb)].find((v) => v !== "<none>");
if (current === undefined) {
  const [setting, source] = admin("select setting || '|' || source from pg_settings where name = 'session_preload_libraries'").split("|");
  assert(!["user", "database", "session"].includes(source), `C07: cannot read the server's session_preload_libraries (source ${source})`);
  current = setting;
}
current = current.replaceAll('"', "");
log("postgres session_preload_libraries before", current);
const libraries = uniq([...current.split(",").map((x) => x.trim()).filter(Boolean), "safeupdate"]);
for (const l of libraries) assert.match(l, /^[A-Za-z0-9_$./-]+$/, "C07: unexpected library name");
// One quoted literal per library: session_preload_libraries is a GUC_LIST_QUOTE list, so a single 'a,b' literal is stored as the
// one file name "a,b" and every new session of the role fails with FATAL: could not access file "a,b".
admin(`alter role postgres in database postgres set session_preload_libraries = ${libraries.map((l) => `'${l}'`).join(", ")}`);
const dlp = admin("show dynamic_library_path");
log("dynamic_library_path after", dlp);
assert.equal(dlp, `${LIB_DIR}:$libdir`, "C07: a new session does not search the pinned directory first");
// Nothing narrower than the server setting may change the search path for a role or database.
assert.equal(admin("select count(*) from pg_db_role_setting s, unnest(s.setconfig) c where c like 'dynamic_library_path=%'"), "0",
  "C07: a role or database overrides dynamic_library_path");
log("postgres role settings", admin("select coalesce(string_agg(array_to_string(s.setconfig, ';'), ' | '), '') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'postgres'"));
log("authenticator role settings", admin("select coalesce(string_agg(array_to_string(s.setconfig, ';'), ' | '), '') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator'"));

// 5. A disposable superuser login for the direct-session suites that LOAD the library themselves (tests/db/safeupdate-support.ts:
//    "superuser, or the library under $libdir/plugins"); Supabase's postgres role is not a superuser. Those suites drop to the
//    authenticated role (become) before every import call. The URL goes to a file outside the evidence directory.
const password = randomBytes(24).toString("hex");
admin(`create role ${SUPERUSER} login superuser password '${password}'`);
const superUrl = new URL(dbUrl.href);
superUrl.username = SUPERUSER;
superUrl.password = password;
writeFileSync(superuserUrlFile, superUrl.href, { mode: 0o600 });
log("direct-session superuser", `${SUPERUSER} created (URL written to a private file, not the evidence)`);

// 6. PostgREST's pool was opened before the change: restart it so every API session (authenticator, preloaded by the image) loads
//    the pinned build too, then wait until the API answers again.
const restartedAt = admin("select now()::text");
docker(["restart", REST_CONTAINER]);
const headers = { apikey: env.TEST_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.TEST_SUPABASE_ANON_KEY}` };
let up = null;
for (let i = 0; i < 90 && up === null; i++) {
  try {
    const res = await fetch(new URL("/rest/v1/organizations?select=id&limit=1", apiUrl), { headers });
    if (![502, 503, 504].includes(res.status)) up = res.status;
  } catch {
    // not answering yet
  }
  if (up === null) await new Promise((r) => setTimeout(r, 1000));
}
assert(up !== null, "C07: the API did not come back after the PostgREST restart");
log("API answers after restart", up);

// 7. Which build is in force, by behaviour (no /proc). 1.6 and later, so the pinned 1.7, call the previous post_parse_analyze hook
//    even with safeupdate.enabled off; the image's 1.4 returns first. pg_stat_statements (shared_preload_libraries) stores a
//    statement's normalised text through that hook, so a statement run with safeupdate off is stored as "... = $1" under 1.7 and
//    with its literal under 1.4. Read as the administrator; each probe uses its own temporary table, so its own entry.
const pgss = admin("select coalesce((select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements'), '')");
log("pg_stat_statements", { schema: pgss, shared_preload_libraries: admin("show shared_preload_libraries"),
  compute_query_id: admin("show compute_query_id"), track: admin("show pg_stat_statements.track") });
assert(pgss, "C07: pg_stat_statements is not installed, so the 1.7 fingerprint cannot be read");
assert.match(evidence.pg_stat_statements.shared_preload_libraries, /(^|,)\s*"?pg_stat_statements"?\s*(,|$)/, "C07: pg_stat_statements is not preloaded");
assert.notEqual(evidence.pg_stat_statements.compute_query_id, "off", "C07: compute_query_id is off");
assert.notEqual(evidence.pg_stat_statements.track, "none", "C07: pg_stat_statements.track is none");
async function fingerprint(c, label) {
  assert.equal((await c.query("select current_setting('safeupdate.enabled', true) as v")).rows[0].v, "off", `C07: ${label}: safeupdate is not off for the probe`);
  const t = `c07_fp_${randomBytes(6).toString("hex")}`;
  await c.query(`create temporary table ${t} (n integer)`);
  await c.query(`select n from ${t} where n = 4242`);
  const stored = admin(`select coalesce(string_agg(query, ' | '), '') from ${pgss}.pg_stat_statements where query like '%from ${t} where%' and query not like '%pg_stat_statements%'`);
  log(`${label}: 1.7 fingerprint (safeupdate off, stored text)`, stored);
  assert.equal(stored, `select n from ${t} where n = $1`, `C07: ${label} does not behave as safeupdate 1.6 or later (1.4 stores the literal 4242)`);
}

// 8. Importer role (postgres, preloaded, no LOAD). The fingerprint needs safeupdate off, which only a superuser may set: set it for
//    the role for one fresh session, then reset it before any other session or test opens.
admin("alter role postgres in database postgres set safeupdate.enabled = off");
try {
  const probe = await client(dbUrl.href);
  try {
    await fingerprint(probe, "importer role (preloaded)");
  } finally {
    await probe.end();
  }
} finally {
  admin("alter role postgres in database postgres reset safeupdate.enabled");
}
log("postgres role settings after the probe", admin("select coalesce(string_agg(array_to_string(s.setconfig, ';'), ' | '), '') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'postgres'"));

const fresh = await client(dbUrl.href);
try {
  // SHOW needs pg_read_all_settings: record its answer or its refusal; the behaviour below is the proof either way.
  try {
    log("importer role SHOW session_preload_libraries", (await fresh.query("show session_preload_libraries")).rows[0].session_preload_libraries);
  } catch (e) {
    log("importer role SHOW session_preload_libraries", `refused: ${e.message}`);
  }
  log("administrator SHOW session_preload_libraries for postgres in postgres", override(pgRole, pgDb));
  log("importer role session", (await fresh.query("select current_user, session_user, (select rolsuper from pg_roles where rolname = current_user) as superuser")).rows[0]);
  const enabled = (await fresh.query("select current_setting('safeupdate.enabled', true) as v")).rows[0].v;
  log("importer role SHOW safeupdate.enabled", enabled);
  assert.equal(enabled, "on", "C07: safeupdate is not active in a fresh importer session");
  await fresh.query("create temporary table c07_probe (n integer)");
  await fresh.query("insert into c07_probe values (1)");
  const bareUpdate = await errorOf(fresh, "update c07_probe set n = 2");
  const bareDelete = await errorOf(fresh, "delete from c07_probe");
  const plpgsql = await errorOf(fresh, "do $$ begin update c07_probe set n = 3; end $$");
  log("importer role bare UPDATE", bareUpdate);
  log("importer role bare DELETE", bareDelete);
  log("importer role bare UPDATE in PL/pgSQL", plpgsql);
  assert.equal(bareUpdate, "UPDATE requires a WHERE clause");
  assert.equal(bareDelete, "DELETE requires a WHERE clause");
  assert.equal(plpgsql, "UPDATE requires a WHERE clause");
  assert.equal(await errorOf(fresh, "update c07_probe set n = 4 where true"), null, "C07: a qualified UPDATE must pass");
  assert.equal(await errorOf(fresh, "delete from c07_probe where n = 4"), null, "C07: a qualified DELETE must pass");
  log("importer role qualified UPDATE and DELETE", "passed");
  // The app import's role (authenticated, as the data import RPCs run): same session, role switched, no LOAD.
  await fresh.query("insert into c07_probe values (1)");
  await fresh.query("grant all on c07_probe to authenticated");
  await fresh.query("set role authenticated");
  const authUpdate = await errorOf(fresh, "update c07_probe set n = 2");
  const authDelete = await errorOf(fresh, "delete from c07_probe");
  log("authenticated bare UPDATE", authUpdate);
  log("authenticated bare DELETE", authDelete);
  assert.equal(authUpdate, "UPDATE requires a WHERE clause");
  assert.equal(authDelete, "DELETE requires a WHERE clause");
  assert.equal(await errorOf(fresh, "update c07_probe set n = 5 where true"), null, "C07: a qualified UPDATE as authenticated must pass");
  log("authenticated qualified UPDATE", "passed");
} finally {
  await fresh.end();
}

// 9. Direct-session suites: the superuser's own LOAD 'safeupdate' (resolved through the same dynamic_library_path).
const su = await client(superUrl.href);
try {
  await su.query("load 'safeupdate'");
  assert.equal((await su.query("select current_setting('safeupdate.enabled', true) as v")).rows[0].v, "on");
  await su.query("create temporary table c07_probe (n integer)");
  const suUpdate = await errorOf(su, "update c07_probe set n = 2");
  log("direct-session (LOAD) bare UPDATE", suUpdate);
  assert.equal(suUpdate, "UPDATE requires a WHERE clause");
  await su.query("set safeupdate.enabled = off");
  await fingerprint(su, "direct-session LOAD");
} finally {
  await su.end();
}

// 10. API sessions: the authenticator role preloads 'safeupdate' (resolved as above), and no authenticator session from before the
//     change is still open (it would still hold the image's library). The per-request proof through PostgREST is the "through the
//     API" tests of tests/db/data-import-safeupdate.test.ts, which the gate requires by name. Which file each API session has
//     mapped is not read: the container refuses /proc/<pid>/maps.
assert.match(evidence["authenticator role settings"], /(^|[;|] ?)session_preload_libraries=[^;|]*\bsafeupdate\b/, "C07: the authenticator role does not preload safeupdate");
let stale = "";
for (let i = 0; i < 30; i++) {
  stale = admin(`select count(*) from pg_stat_activity where usename = 'authenticator' and backend_start <= '${restartedAt}'::timestamptz`);
  if (stale === "0") break;
  await new Promise((r) => setTimeout(r, 1000));
}
log("API (authenticator) sessions from before the restart still open", stale);
assert.equal(stale, "0", "C07: an API session from before the change is still open");
log("API (authenticator) sessions since the restart", admin(`select count(*) from pg_stat_activity where usename = 'authenticator' and backend_start > '${restartedAt}'::timestamptz`));

writeFileSync(path.join(evidenceDir, "safeupdate.json"), JSON.stringify(evidence, null, 2));
console.log("C07: pinned pg-safeupdate 1.7 installed, resolved first, preloaded and enforced in importer, authenticated and direct-session sessions; API role preloads it.");
