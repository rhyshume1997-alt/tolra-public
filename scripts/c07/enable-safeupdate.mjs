// C07: install the pinned pg-safeupdate build (scripts/c07/build-safeupdate.sh) into the runner-owned disposable Supabase
// database container, make it the library every new session resolves, preload it for the importer's direct role, and prove it
// with the real library: which file each kind of session has mapped, SHOW session_preload_libraries, and the real errors of a
// bare UPDATE and DELETE. Every step that fails throws; nothing is skipped.
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
const mapsOf = (pid) => docker(["exec", "-u", "root", DB_CONTAINER, "cat", `/proc/${pid}/maps`]).split("\n")
  .map((l) => l.trim().split(/\s+/).slice(5).join(" ")).filter((p) => /safeupdate/.test(p));
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
log("installed library", { path: LIB, sha256: info.library_sha256 });

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
const libraries = uniq([...current.split(",").map((x) => x.trim()).filter(Boolean), "safeupdate"]).join(",");
assert.match(libraries, /^[A-Za-z0-9_$,./-]+$/, "C07: unexpected library list");
admin(`alter role postgres in database postgres set session_preload_libraries = '${libraries}'`);
log("dynamic_library_path after", admin("show dynamic_library_path"));
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

// 7. Proof, importer role: a NEW postgres session (no LOAD) has the pinned file mapped and refuses a bare UPDATE and DELETE.
const fresh = await client(dbUrl.href);
try {
  // SHOW needs pg_read_all_settings: record its answer or its refusal; the mapped files below are the proof either way.
  try {
    log("importer role SHOW session_preload_libraries", (await fresh.query("show session_preload_libraries")).rows[0].session_preload_libraries);
  } catch (e) {
    log("importer role SHOW session_preload_libraries", `refused: ${e.message}`);
  }
  log("administrator SHOW session_preload_libraries for postgres in postgres", override(pgRole, pgDb));
  log("importer role session", (await fresh.query("select current_user, session_user, (select rolsuper from pg_roles where rolname = current_user) as superuser")).rows[0]);
  assert.equal((await fresh.query("select current_setting('safeupdate.enabled', true) as v")).rows[0].v, "on", "C07: safeupdate is not active in a fresh importer session");
  const pid = (await fresh.query("select pg_backend_pid() as pid")).rows[0].pid;
  const mapped = uniq(mapsOf(pid));
  log("importer role mapped safeupdate", mapped);
  log("importer role mapped supautils (kept as it was)", uniq(docker(["exec", "-u", "root", DB_CONTAINER, "cat", `/proc/${pid}/maps`]).split("\n")
    .map((l) => l.trim().split(/\s+/).slice(5).join(" ")).filter((x) => /supautils/.test(x))));
  assert.deepEqual(mapped, [LIB], "C07: the importer session did not map exactly the pinned build");
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
} finally {
  await fresh.end();
}

// 8. Proof, direct-session suites: the superuser's own LOAD 'safeupdate' maps the pinned build.
const su = await client(superUrl.href);
try {
  await su.query("load 'safeupdate'");
  assert.equal((await su.query("select current_setting('safeupdate.enabled', true) as v")).rows[0].v, "on");
  const mapped = uniq(mapsOf((await su.query("select pg_backend_pid() as pid")).rows[0].pid));
  log("direct-session LOAD mapped safeupdate", mapped);
  assert.deepEqual(mapped, [LIB], "C07: LOAD 'safeupdate' did not map exactly the pinned build");
} finally {
  await su.end();
}

// 9. Proof, API sessions: every authenticator backend PostgREST now holds has the pinned build mapped.
const pids = admin(`select coalesce(string_agg(pid::text, ' '), '') from pg_stat_activity where usename = 'authenticator' and backend_start > '${restartedAt}'::timestamptz`).split(/\s+/).filter(Boolean);
assert(pids.length > 0, "C07: no PostgREST (authenticator) session to inspect");
const apiMaps = Object.fromEntries(pids.map((p) => [p, uniq(mapsOf(p))]));
log("API (authenticator) sessions mapped safeupdate", apiMaps);
for (const [p, m] of Object.entries(apiMaps)) assert.deepEqual(m, [LIB], `C07: API session ${p} did not map exactly the pinned build`);

writeFileSync(path.join(evidenceDir, "safeupdate.json"), JSON.stringify(evidence, null, 2));
console.log("C07: pinned pg-safeupdate 1.7 installed, preloaded and enforced in importer, authenticated, direct-session and API sessions.");
