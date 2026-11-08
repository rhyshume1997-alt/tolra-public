/**
 * Temporary directories for tests that are removed when the test file ends (candidate 2F, F10: the SliQ unit tests left about 260
 * directories, 37 MB, in the system temp folder on every run). Import it from a test file (or a support module a test file imports):
 * the afterAll below then belongs to that file (vitest isolates each test file's modules).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const made: string[] = [];

/** mkdtempSync in the system temp folder, removed (recursively) after this test file's last test. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Removes every directory tempDir made so far (also run by the afterAll below). */
export function removeTempDirs() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

afterAll(removeTempDirs);
