import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(__dirname, "../../scripts/ci-146-rollback-evidence.sh");

// The real refusal when 146 is installed again after its rollback: the retained key_source column (146 release line 37, SQLSTATE 42701).
const REAL_REFUSAL = 'column "key_source" of relation "ai_helper_requests" already exists';

// A fake psql: exits 0/1 by the file it is given. When the reinstall fails it prints the given message after "ERROR:  " (null = no ERROR line at all).
// The message travels in a file, so no shell quoting is involved.
function run(rollbackOk: boolean, reinstallOk: boolean, reinstallMessage: string | null = REAL_REFUSAL) {
  const root = mkdtempSync(path.join(tmpdir(), "ev146-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(root, "reinstall-message.txt"), reinstallMessage ?? "");
  const fake = `#!/usr/bin/env bash
file=""; while [ $# -gt 0 ]; do [ "$1" = -f ] && file="$2"; shift; done
case "$file" in
  *rollback.sql) ${rollbackOk ? "exit 0" : 'echo "ERROR:  Settle outstanding Tolra requests before rollback."; exit 1'} ;;
  *release.sql) ${reinstallOk ? "exit 0" : `${reinstallMessage === null ? "" : `echo "psql:supabase/release/146_tolra_provided_ai.release.sql:37: ERROR:  $(cat "${path.join(root, "reinstall-message.txt")}")"; `}exit 1`} ;;
esac
exit 2
`;
  writeFileSync(path.join(bin, "psql"), fake);
  chmodSync(path.join(bin, "psql"), 0o755);
  const r = spawnSync("bash", [script, path.join(root, "evidence")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DATABASE_URL: "postgresql://x@127.0.0.1:1/db" },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout };
}

describe("ci-146-rollback-evidence.sh", () => {
  it("rollback accepted + reinstall refused with the real key_source refusal => PASS, exit 0", () => {
    const r = run(true, false);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^PASS /m);
  });
  it("the PASS case also matches the refusal printed with SQLSTATE verbosity", () => {
    expect(run(true, false, `42701: ${REAL_REFUSAL}`).out).toMatch(/^PASS /m);
  });
  it("rollback accepted + reinstall accepted => FAIL, exit 1, no PASS", () => {
    const r = run(true, true);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL /m);
    expect(r.out).not.toMatch(/PASS/);
  });
  it("rollback refused => NOT-PROVEN, exit 0, no PASS", () => {
    const r = run(false, false);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^NOT-PROVEN /m);
    expect(r.out).not.toMatch(/PASS/);
  });
  it("reinstall failed without an ERROR line => NOT-PROVEN, no PASS", () => {
    const r = run(true, false, null);
    expect(r.out).toMatch(/^NOT-PROVEN /m);
    expect(r.out).not.toMatch(/PASS/);
  });
  it("reinstall failed with an unrelated database error => NOT-PROVEN, exit 0, never PASS", () => {
    for (const msg of [
      "permission denied for table ai_helper_requests",
      'relation "ai_helper_tolra_control" does not exist',
      'column "other" of relation "ai_helper_requests" already exists',
      'column "key_source" of relation "other_table" already exists',
      "Review the existing reserve functions before applying N2; expected 133 and 134.",
    ]) {
      const r = run(true, false, msg);
      expect(r.code, msg).toBe(0);
      expect(r.out, msg).toMatch(/^NOT-PROVEN /m);
      expect(r.out, msg).not.toMatch(/PASS/);
    }
  });
});
