import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tolra-backend-script-"));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync("scripts/test-backend.sh", path.join(root, "scripts/test-backend.sh"));
  writeFileSync(path.join(root, "fake-supabase"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$SUPABASE_INTERNAL_IMAGE_REGISTRY" >> "$BACKEND_REGISTRY_PROOF"
case "$1" in
 start) exit 0 ;;
 status)
  printf 'API_URL=%s\\nDB_URL=%s\\nANON_KEY=local-test-only\\nSERVICE_ROLE_KEY=local-test-only\\n' "\${FAKE_API_URL:-http://127.0.0.1:54321}" "\${FAKE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
  ;;
 *) exit 2 ;;
esac
`, { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(extra: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, SUPABASE_BIN: path.join(root, "fake-supabase"), BACKEND_REGISTRY_PROOF: path.join(root, "registry.txt"), ...extra };
  delete env.SUPABASE_INTERNAL_IMAGE_REGISTRY;
  Object.assign(env, extra);
  return spawnSync("bash", [path.join(root, "scripts/test-backend.sh"), "start"], { env, encoding: "utf8" });
}
it("uses the same official image registry as CI and writes only local backend coordinates", () => {
  const result = run();
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path.join(root, "registry.txt"), "utf8").trim().split("\n")).toEqual(["ghcr.io", "ghcr.io"]);
  expect(readFileSync(path.join(root, ".env.test.local"), "utf8")).toContain("TEST_SUPABASE_URL=http://127.0.0.1:54321");
});
it("preserves an explicitly configured registry, with no silent fallback", () => {
  expect(run({ SUPABASE_INTERNAL_IMAGE_REGISTRY: "registry.example.test" }).status).toBe(0);
  expect(readFileSync(path.join(root, "registry.txt"), "utf8").trim().split("\n")).toEqual(["registry.example.test", "registry.example.test"]);
});
it.each([
  { FAKE_API_URL: "https://hosted.example.test" },
  { FAKE_DB_URL: "postgresql://postgres:synthetic@hosted.example.test/postgres" },
])("refuses hosted coordinates before writing test settings: %j", extra => {
  const result = run(extra);
  expect(result.status).toBe(1); expect(result.stderr).toContain("Refusing");
  expect(existsSync(path.join(root, ".env.test.local"))).toBe(false);
});
