/**
 * scripts/ci-statement-diagnostic.sh and its CI step. Inputs: a fake `psql` on PATH (no database), the script, .github/workflows/ci.yml.
 * Proves: the SQL guard (comments, strings, plpgsql bodies, mixed case, transaction and session commands), the wrapper's own BEGIN / ROLLBACK as
 * separate commands, the three-way rollback and fingerprint verdicts (UNVERIFIED is never UNCHANGED), honest source locations, credential
 * safety on stdout and stderr, the exact-name settings allowlist, and that the step can never fail or weaken a required check.
 * Must not change: this file proves, it never edits a release, a fixture or a database.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/ci-statement-diagnostic.sh");
const PW = "S3cr3t!pw-ZZ9";
const URL_ = `postgresql://postgres:${encodeURIComponent(PW)}@127.0.0.1:54322/postgres`;

// "@{" stands for a bash "${" (a TypeScript template literal would otherwise read it).
const FAKE = String.raw`#!/usr/bin/env bash
mode="@{FAKE_MODE:-ok}"; log="$FAKE_LOG"
cs=(); args=("$@")
for ((i=0;i<@{#args[@]};i++)); do case "@{args[i]}" in -c) cs+=("@{args[i+1]}");; esac; done
echo CALL >> "$log"
for ((i=0;i<@{#args[@]};i++)); do case "@{args[i]}" in -c) echo "C: @{args[i+1]}" >> "$log";; esac; done
if [ "$mode" = leak ]; then echo "connecting to @{FAKE_URL} password=@{FAKE_PW}"; echo "boom @{FAKE_PW} @{FAKE_URL}" >&2; echo 'FATAL:  password authentication failed for user "postgres"' >&2; fi
[ "$mode" = dead ] && exit 2
n=0; [ -f "$log.n" ] && n=$(cat "$log.n")
first="@{cs[0]:-}"
case "$first" in
  "select 'ok'") echo ok; exit 0 ;;
  "select 'supautils.policy_grants|'"*) echo "supautils.policy_grants|{\"postgres\":[\"storage.objects\"]}"; echo "supautils.privileged_role|not set or not readable"; echo "some.secret_key|hunter2"; echo "shared_preload_libraries|supautils"; exit 0 ;;
  "select 'ended"*) echo "ended 1"; exit 0 ;;
  "select 'FP "*)
    n=$((n+1)); echo $n > "$log.n"
    [ "$mode" = fpempty ] && exit 0
    if [ "$mode" = changed ] && [ $((n%2)) = 0 ]; then echo "FP policies=bbb comment159=none table=ccc"; else echo "FP policies=aaa comment159=none table=ccc"; fi
    exit 0 ;;
esac
if [ "$first" = BEGIN ]; then
  echo BEGIN
  for c in "@{cs[@]:1}"; do
    case "$c" in
      '\warn '*) echo "@{c#\\warn }" >&2 ;;
      "ALTER POLICY"*) if [ "$mode" = fail ] || [ "$mode" = noloc ]; then echo "ERROR:  42501: must be owner of table objects"; [ "$mode" = fail ] && echo "LOCATION:  aclcheck_error, aclchk.c:2981"; else echo "ALTER POLICY"; fi ;;
      "COMMENT ON POLICY \"job"*) if [ "$mode" = fail ]; then echo "ERROR:  42501: must be owner of relation objects"; echo "LOCATION:  aclcheck_error, aclchk.c:2981"; elif [ "$mode" = noloc ]; then echo "ERROR:  42501: must be owner of relation objects"; else echo COMMENT; fi ;;
      "COMMENT ON POLICY \"customers"*) if [ "$mode" = nocontrol ]; then echo "ERROR:  42704: policy \"customers rbac select\" for table \"customers\" does not exist"; echo "LOCATION:  get_relation_policy_oid, policy.c:1"; else echo COMMENT; fi ;;
      "select 'FP "*) echo "FP policies=aaa comment159=none table=ccc" ;;
      ROLLBACK) if [ "$mode" = norollback ]; then exit 2; fi; echo ROLLBACK ;;
    esac
  done
  exit 0
fi
exit 0
`;

let STUB: string;
let LOGDIR: string;
beforeAll(() => {
  STUB = mkdtempSync(path.join(tmpdir(), "diag-stub-"));
  writeFileSync(path.join(STUB, "psql"), FAKE.replaceAll("@{", "${"));
  chmodSync(path.join(STUB, "psql"), 0o755);
  LOGDIR = mkdtempSync(path.join(tmpdir(), "diag-log-"));
});

let counter = 0;
function run(mode: string, opts: { url?: string; fakeUrl?: string; fakePw?: string } = {}) {
  const log = path.join(LOGDIR, `calls-${++counter}.log`);
  writeFileSync(log, "");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${STUB}:${process.env.PATH}`, TEST_DATABASE_URL: opts.url ?? URL_, FAKE_MODE: mode, FAKE_LOG: log, FAKE_URL: opts.fakeUrl ?? URL_, FAKE_PW: opts.fakePw ?? PW },
  });
  const calls = readFileSync(log, "utf8");
  const lines = r.stdout.trim().split("\n");
  return { r, out: `${r.stdout}\n${r.stderr}`, calls, lines };
}
const guard = (sql: string) => spawnSync("bash", [SCRIPT, "--guard-only"], { input: sql, encoding: "utf8" });
const cArgs = (calls: string) => calls.split("\n").filter((l) => l.startsWith("C: ")).map((l) => l.slice(3));

describe("the SQL guard", () => {
  it.each([
    ["a plain statement", "ALTER POLICY x ON t USING (false);", 0],
    ["a comment that contains COMMIT", "-- we never COMMIT here\nSELECT 1;", 0],
    ["a block comment that contains ROLLBACK", "/* ROLLBACK; COMMIT; */ SELECT 1;", 0],
    ["a string literal that contains rollback", "SELECT 'rolled back, rollback, commit; end';", 0],
    ["the COMMENT string of release 159 (contains rollback.sql)", "COMMENT ON POLICY p ON t IS 'rolled back by 159_drawings_update_roles.rollback.sql';", 0],
    ["plpgsql BEGIN at column 0 and END inside a dollar body", "DO $p$\nBEGIN\n  IF true THEN NULL; END IF;\nEND $p$;", 0],
    ["a tagged dollar body ending with END $tag$;", "DO $post_release_guard$ BEGIN PERFORM 1; END $post_release_guard$;", 0],
    ["a quoted identifier called begin", 'SELECT "begin" FROM t;', 0],
    ["Commit; (mixed case)", "Commit;", 3],
    ["commit ; (space before the semicolon)", "commit ;", 3],
    ["COMMIT after a comment", "/* x */ COMMIT;", 3],
    ["a top-level END;", "END;", 3],
    ["ABORT", "abort;", 3],
    ["ROLLBACK TO SAVEPOINT", "ROLLBACK TO SAVEPOINT a;", 3],
    ["ROLLBACK", "rollback;", 3],
    ["SAVEPOINT in the middle", "select 1; Savepoint s;", 3],
    ["RELEASE SAVEPOINT", "release savepoint s;", 3],
    ["START TRANSACTION;", "START TRANSACTION;", 3],
    ["a second BEGIN", "select 1;\nBegin Transaction;", 3],
    ["PREPARE TRANSACTION", "prepare transaction 'x';", 3],
    ["COMMIT AND CHAIN", "COMMIT AND CHAIN;", 3],
    ["SET ROLE", "set role postgres;", 3],
    ["SET SESSION AUTHORIZATION", "SET SESSION AUTHORIZATION postgres;", 3],
    ["RESET ROLE", "RESET ROLE;", 3],
    ["a psql backslash command", "select 1;\n\\i evil.sql", 3],
    ["\\c", "\\c otherdb", 3],
  ])("%s", (_name, sql, code) => {
    expect(guard(sql as string).status).toBe(code);
  });

  it("names the line and the kind of statement it refused", () => {
    const g = guard("select 1;\n/* c */ Commit;");
    expect(g.stdout).toContain("COMMIT");
    expect(g.stdout).toContain("line 2");
  });
});

describe("the wrapper's transaction", () => {
  it("sends its own BEGIN first and ROLLBACK last as separate -c arguments, never joined to the inspected SQL", () => {
    const { r, calls } = run("ok");
    expect(r.status).toBe(0);
    const txCall = calls.split("CALL\n").find((c) => c.includes("C: BEGIN"))!;
    const cs = cArgs(txCall);
    expect(cs[0]).toBe("BEGIN");
    expect(cs.at(-1)).toBe("ROLLBACK");
    for (const c of cs) {
      if (/^(ALTER POLICY|COMMENT ON POLICY)/.test(c)) expect(c).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
      if (c === "BEGIN" || c === "ROLLBACK") expect(c).not.toMatch(/ALTER|COMMENT|;/);
    }
    expect(calls).not.toMatch(/^C: (COMMIT|END|ABORT)\b/im);
  });

  it("ends with one line for the rollback and one for the state: ROLLBACK CONFIRMED and fingerprint UNCHANGED", () => {
    const { lines } = run("ok");
    expect(lines.at(-2)).toBe("ROLLBACK CONFIRMED");
    expect(lines.at(-1)).toBe("fingerprint UNCHANGED");
  });

  it("a failed probe: SQLSTATE, message, server location; the FIRST failing probe is named first and later ones as later", () => {
    const { r, out, calls } = run("fail");
    expect(r.status).toBe(0);
    expect(out).toMatch(/probe 1 \(ALTER POLICY[^\n]*FAILED sqlstate=42501 message="must be owner of table objects" server-location=aclcheck_error, aclchk\.c:2981/);
    expect(out).toMatch(/probe 2 \(COMMENT ON POLICY[^\n]*FAILED sqlstate=42501 message="must be owner of relation objects" server-location=aclcheck_error, aclchk\.c:2981/);
    expect(out).toContain("FIRST failing probe: 1");
    expect(out).toContain("later failing probes (may be consequences of the first): 2");
    expect(out).toContain("probe 3 (control");
    expect(out).toContain("ROLLBACK CONFIRMED");
    expect(calls).toContain("C: ROLLBACK");
  });

  it("probe mode never claims a source line: psql gives none for -c, so 'source-line=unavailable', and no release-file line number", () => {
    const { out } = run("fail");
    expect(out).toMatch(/source-line=unavailable/);
    expect(out).not.toMatch(/file-line|release file|line (65|70)\b/i);
  });

  it("says 'unavailable' for the server location when PostgreSQL gave none, and never invents one", () => {
    const { out } = run("noloc");
    expect(out).toMatch(/probe 2[^\n]*FAILED sqlstate=42501[^\n]*server-location=unavailable/);
  });

  it("the control names one fixed public policy; if it is missing it says the control is unavailable and picks no other", () => {
    const { out, calls } = run("nocontrol");
    expect(out).toMatch(/probe 3[^\n]*FAILED sqlstate=42704[^\n]*control unavailable/);
    expect(calls).toContain('COMMENT ON POLICY "customers rbac select" ON public.customers');
    expect(calls).not.toMatch(/pg_policies WHERE schemaname/i);
  });

  it("a ROLLBACK command that fails: ROLLBACK NOT CONFIRMED, an annotation, own-backend cleanup, the fresh-session fingerprint still read, exit 0", () => {
    const { r, lines, out, calls } = run("norollback");
    expect(r.status).toBe(0);
    expect(lines.at(-2)).toBe("ROLLBACK NOT CONFIRMED");
    expect(out).toMatch(/::error title=statement diagnostic::ROLLBACK NOT CONFIRMED/);
    expect(calls).toMatch(/pg_terminate_backend/);
    expect(calls).toMatch(/application_name = 'ci-statement-diagnostic-\d+'/);
    const sessions = calls.split("CALL\n").map((c) => cArgs(c));
    const fresh = sessions.filter((cs) => cs.length === 1 && cs[0].startsWith("select 'FP "));
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    expect(lines.at(-1)).toBe("fingerprint UNCHANGED");
  });

  it("a fingerprint that differs: CHANGED, an annotation saying the run's results are void, exit 0", () => {
    const { r, lines, out } = run("changed");
    expect(r.status).toBe(0);
    expect(lines.at(-1)).toBe("fingerprint CHANGED");
    expect(out).toMatch(/::error title=statement diagnostic::fingerprint CHANGED after the probes; this run's required results are void/);
  });

  it("a fingerprint that cannot be read in a fresh session: UNVERIFIED, never UNCHANGED, with an annotation", () => {
    const { r, lines, out } = run("fpempty");
    expect(r.status).toBe(0);
    expect(lines.at(-1)).toBe("fingerprint UNVERIFIED");
    expect(out).not.toMatch(/fingerprint UNCHANGED/);
    expect(out).toMatch(/::error title=statement diagnostic::fingerprint UNVERIFIED/);
  });

  it("the before and after fingerprints are separate fresh-session reads compared in the shell", () => {
    const { calls } = run("ok");
    const sessions = calls.split("CALL\n").map((c) => cArgs(c));
    const fresh = sessions.filter((cs) => cs.length === 1 && cs[0].startsWith("select 'FP "));
    expect(fresh).toHaveLength(2);
  });

  it("a database that cannot be reached exits 0 and says nothing was run", () => {
    const { r, out } = run("dead");
    expect(r.status).toBe(0);
    expect(out).toContain("could not be reached");
  });
});

describe("credential safety", () => {
  it("never prints the password or any connection string, on stdout or stderr, even when psql itself prints them", () => {
    const { out } = run("leak");
    expect(out).not.toContain(PW);
    expect(out).not.toContain(encodeURIComponent(PW));
    expect(out).not.toMatch(/postgres(ql)?:\/\//i);
    expect(out).not.toMatch(/postgres:[^\s@]*@127\.0\.0\.1/);
    expect(out).toContain("[connection string redacted]");
  });

  it("the CI shape postgres:postgres@127.0.0.1 keeps the role name 'postgres' everywhere it is evidence, and still redacts the connection string", () => {
    const ciUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    const { out } = run("leak", { url: ciUrl, fakeUrl: ciUrl, fakePw: "postgres" });
    expect(out).toContain('supautils.policy_grants = {"postgres":["storage.objects"]}');
    expect(out).toContain('password authentication failed for user "postgres"');
    expect(out).not.toMatch(/postgres(ql)?:\/\//i);
    expect(out).not.toMatch(/postgres:postgres@/);
    expect(out).toContain("[connection string redacted]");
    expect(out).toContain("password=[redacted]");
  });

  it("a distinctive password is redacted as a bare literal too, on stdout and stderr", () => {
    const { r, out } = run("leak");
    expect(`${r.stdout}`).not.toContain(PW);
    expect(`${r.stderr}`).not.toContain(PW);
    expect(out).not.toContain(PW);
  });

  it("a percent-encoded password is redacted in both its encoded and decoded forms", () => {
    const raw = "p@ss w0rd/9!Zq";
    const enc = encodeURIComponent(raw);
    const url = `postgresql://postgres:${enc}@127.0.0.1:54322/postgres`;
    const { out } = run("leak", { url, fakeUrl: url, fakePw: raw });
    expect(out).not.toContain(raw);
    expect(out).not.toContain(enc);
    expect(out).not.toContain("w0rd");
    expect(out).toContain('supautils.policy_grants = {"postgres":["storage.objects"]}');
  });

  it("reads exactly four settings by exact name with current_setting(name, true), and a non-listed supautils setting is never queried", () => {
    const { calls } = run("ok");
    const settingsSql = cArgs(calls).find((c) => c.startsWith("select 'supautils.policy_grants|'"))!;
    const names = [...settingsSql.matchAll(/current_setting\('([^']+)', true\)/g)].map((m) => m[1]);
    expect(names).toEqual(["supautils.policy_grants", "supautils.drop_trigger_grants", "supautils.privileged_role", "supautils.reserved_roles"]);
    expect(settingsSql).not.toMatch(/pg_settings|like|ilike|~|select \*/i);
    expect(cArgs(calls).join("\n")).not.toMatch(/reserved_memberships|shared_preload|pg_authid|rolpassword/i);
  });

  it("prints a setting that is not set as 'not set or not readable', and drops any row that is not one of the four", () => {
    const { out } = run("ok");
    expect(out).toContain("supautils.policy_grants =");
    expect(out).toContain("supautils.privileged_role = not set or not readable");
    expect(out).not.toContain("some.secret_key");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("shared_preload_libraries");
  });

  it("the refusal for a URL that is not the local disposable database prints no URL and calls no psql", () => {
    const secretUrl = "postgresql://postgres:TopSecretPw@db.example.com:5432/postgres";
    const { r, out, calls } = run("ok", { url: secretUrl });
    expect(r.status).toBe(0);
    expect(out).toContain("not the local disposable database");
    expect(out).not.toContain("TopSecretPw");
    expect(out).not.toContain("db.example.com");
    expect(calls).toBe("");
  });

  it("does nothing without TEST_DATABASE_URL, and the script never traces or echoes the URL", () => {
    const { r, out, calls } = run("ok", { url: "" });
    expect(r.status).toBe(0);
    expect(out).toContain("not set");
    expect(calls).toBe("");
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).not.toMatch(/set -x|set -o xtrace|printenv|echo[^\n]*\$URL|printf[^\n]*\$URL|say[^\n]*\$URL/);
  });
});

describe("what the script may contain, and its CI step", () => {
  const script = readFileSync(SCRIPT, "utf8");

  it("its probes are exactly release 159's two statements and one fixed control; nothing grants, switches role or connects as another login", () => {
    const block = script.slice(script.indexOf("# PROBE-SQL-BEGIN"), script.indexOf("# PROBE-SQL-END"));
    const sqls = [...block.matchAll(/^P\d_SQL=(['"])([\s\S]*?)\1$/gm)].map((m) => m[2]);
    expect(sqls).toHaveLength(3);
    expect(sqls[0]).toBe('ALTER POLICY "job drawings org update" ON storage.objects USING (false) WITH CHECK (false)');
    expect(sqls[1]).toBe(
      'COMMENT ON POLICY \\"job drawings org update\\" ON storage.objects IS \'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql\'',
    );
    expect(sqls[2]).toBe('COMMENT ON POLICY \\"customers rbac select\\" ON public.customers IS \'ci-statement-diagnostic control\'');
    expect(script).not.toMatch(/SET ROLE|SESSION AUTHORIZATION|GRANT |REVOKE |ALTER ROLE|CREATE ROLE|supabase_admin|--username|-U /);
    expect(script).not.toMatch(/-c ['"](COMMIT|END|ABORT)['"]/i);
  });

  it("the CI step is informational: always(), continue-on-error, timed, after the environment export and before the Database suite, calling only the script", () => {
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const start = ci.indexOf('name: "Statement diagnostic (informational');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(ci.indexOf("name: Export this job's disposable test environment"));
    expect(start).toBeLessThan(ci.indexOf("name: Database suite ("));
    const step = ci.slice(start, ci.indexOf("\n      - name:", start + 10));
    expect(step).toContain("if: ${{ always() }}");
    expect(step).toContain("continue-on-error: true");
    expect(step).toMatch(/timeout-minutes: \d+/);
    expect(step).toContain("run: bash scripts/ci-statement-diagnostic.sh");
    expect(step).not.toMatch(/secrets\.|supabase_admin|SET ROLE|psql/);
    // the residual risk is stated next to the step
    expect(ci.slice(ci.lastIndexOf("# Informational (never gates", start), start)).toMatch(/results are void/);
    // the required checks are untouched
    expect(ci).toContain("run: npm run test:db");
    expect(ci.match(/name: "Statement diagnostic/g)).toHaveLength(1);
  });

  it("parses as bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" }).status).toBe(0);
  });
});
