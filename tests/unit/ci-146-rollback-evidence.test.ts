import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(__dirname, "../../scripts/ci-146-rollback-evidence.sh");

// A fake psql: exits 0/1 by the file it is given, and writes an ERROR line when it fails (optionally none).
function run(rollbackOk: boolean, reinstallOk: boolean, reinstallErrorLine = true) {
  const root = mkdtempSync(path.join(tmpdir(), "ev146-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const fake = `#!/usr/bin/env bash
file=""; while [ $# -gt 0 ]; do [ "$1" = -f ] && file="$2"; shift; done
case "$file" in
  *rollback.sql) ${rollbackOk ? "exit 0" : 'echo "ERROR:  Settle outstanding Tolra requests before rollback."; exit 1'} ;;
  *release.sql) ${reinstallOk ? "exit 0" : `${reinstallErrorLine ? 'echo "ERROR:  column key_source already exists"; ' : ""}exit 1`} ;;
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
  it("rollback accepted + reinstall refused => PASS, exit 0", () => {
    const r = run(true, false);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^PASS /m);
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
    const r = run(true, false, false);
    expect(r.out).toMatch(/^NOT-PROVEN /m);
    expect(r.out).not.toMatch(/PASS/);
  });
});
