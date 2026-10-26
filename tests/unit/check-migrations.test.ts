/** Applied-migration freeze and new-migration file set (guardrails c and d): scripts/check-migrations.mjs. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkMigrations } from "../../scripts/check-migrations.mjs";

const repo = path.resolve(__dirname, "../..");
const script = path.join(repo, "scripts/check-migrations.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A synthetic repo: applied 001 (migration, release, verify, rollback) and 002 (migration only), nothing new. */
function tree() {
  const root = mkdtempSync(path.join(tmpdir(), "check-migrations-"));
  dirs.push(root);
  for (const d of ["migrations", "release", "verify"]) mkdirSync(path.join(root, "supabase", d), { recursive: true });
  const put = (rel: string, text: string) => {
    writeFileSync(path.join(root, rel), text);
    return { path: rel, sha256: sha(text) };
  };
  const manifest = {
    migrations: {
      "001": {
        migration: put("supabase/migrations/001_first.sql", "select 1;\n"),
        release: put("supabase/release/001_first.release.sql", "begin; select 1; commit;\n"),
        rollback: put("supabase/release/001_first.rollback.sql", "select -1;\n"),
        verify: put("supabase/verify/first_001.sql", "select true;\n"),
      },
      "002": { migration: put("supabase/migrations/002_second.sql", "select 2;\n") },
    },
  };
  writeFileSync(path.join(root, "supabase/applied-migrations.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, "supabase/verify/release_preflight.sql"), "VALUES\n    ('001 first', true)\n");
  return root;
}
const write = (root: string, rel: string, text: string) => writeFileSync(path.join(root, rel), text);

/** Adds a complete new migration 003; callers then remove one piece. */
function addNew(root: string) {
  write(root, "supabase/migrations/003_third.sql", "select 3;\n");
  write(root, "supabase/release/003_third.release.sql", "begin; select 3; commit;\n");
  write(root, "supabase/release/003_third.rollback.sql", "select -3;\n");
  write(root, "supabase/verify/third_003.sql", "select true;\n");
  write(root, "supabase/verify/release_preflight.sql", "VALUES\n    ('001 first', true),\n    ('003 third', true)\n");
}

describe("applied migrations are frozen (c)", () => {
  it("passes when every listed file is unchanged", () => {
    const r = checkMigrations(tree());
    expect(r).toEqual({ problems: [], applied: 2, added: [] });
  });

  it.each([
    ["migration", "supabase/migrations/001_first.sql"],
    ["release", "supabase/release/001_first.release.sql"],
    ["rollback", "supabase/release/001_first.rollback.sql"],
    ["verify", "supabase/verify/first_001.sql"],
  ])("fails when an applied %s file is edited", (kind, rel) => {
    const root = tree();
    write(root, rel, readFileSync(path.join(root, rel), "utf8") + "-- edited\n");
    const { problems } = checkMigrations(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Applied migration 001 changed: write a new migration instead");
    expect(problems[0]).toContain(`${kind} file ${rel}`);
  });

  it("fails when a listed file is deleted", () => {
    const root = tree();
    unlinkSync(path.join(root, "supabase/migrations/002_second.sql"));
    const { problems } = checkMigrations(root);
    expect(problems).toEqual([expect.stringContaining("Applied migration 002 migration file is missing or renamed: supabase/migrations/002_second.sql")]);
  });

  it("fails when a listed file is renamed, and says so for the old and the new name", () => {
    const root = tree();
    renameSync(path.join(root, "supabase/migrations/002_second.sql"), path.join(root, "supabase/migrations/002_other.sql"));
    const { problems } = checkMigrations(root);
    expect(problems.some((p) => p.includes("Applied migration 002") && p.includes("missing or renamed"))).toBe(true);
    expect(problems.some((p) => p.includes("number reused by supabase/migrations/002_other.sql"))).toBe(true);
  });

  it("fails when another file takes an applied number", () => {
    const root = tree();
    write(root, "supabase/migrations/001_again.sql", "select 1;\n");
    expect(checkMigrations(root).problems).toEqual([expect.stringContaining("Applied migration 001 number reused by supabase/migrations/001_again.sql")]);
  });

  it("fails clearly without a manifest or with a broken one", () => {
    const root = tree();
    write(root, "supabase/applied-migrations.json", "{ nope");
    expect(checkMigrations(root).problems[0]).toMatch(/not valid JSON/);
    unlinkSync(path.join(root, "supabase/applied-migrations.json"));
    expect(checkMigrations(root).problems).toEqual(["supabase/applied-migrations.json is missing"]);
  });
});

describe("documented exceptions", () => {
  const rel = "supabase/migrations/002_second.sql";
  const full = { commit: "a7198394", reason: "guard only", production_note: "production was not repasted" };
  function withException(root: string, ex: Record<string, unknown>) {
    const mp = path.join(root, "supabase/applied-migrations.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    m.exceptions = ex;
    writeFileSync(mp, JSON.stringify(m));
  }

  it("passes a file whose sha256 matches its exception, keeping the applied sha256 recorded", () => {
    const root = tree();
    write(root, rel, "select 2; -- guard\n");
    withException(root, { [rel]: { sha256: sha("select 2; -- guard\n"), ...full } });
    expect(checkMigrations(root).problems).toEqual([]);
  });

  it("fails the same file with any other change", () => {
    const root = tree();
    write(root, rel, "select 2; -- guard\n");
    withException(root, { [rel]: { sha256: sha("select 2; -- guard\n"), ...full } });
    write(root, rel, "select 2; -- guard\n-- again\n");
    expect(checkMigrations(root).problems).toEqual([expect.stringContaining("Applied migration 002 changed")]);
  });

  it("does not let an exception for another path or another sha excuse the file", () => {
    const root = tree();
    write(root, rel, "select 2; -- guard\n");
    withException(root, { "supabase/migrations/001_first.sql": { sha256: sha("select 2; -- guard\n"), ...full }, [rel]: { sha256: sha("other"), ...full } });
    expect(checkMigrations(root).problems).toEqual([expect.stringContaining("Applied migration 002 changed")]);
  });

  it.each(["sha256", "commit", "reason", "production_note"])("fails an exception missing %s", (field) => {
    const root = tree();
    write(root, rel, "select 2; -- guard\n");
    const ex: Record<string, unknown> = { sha256: sha("select 2; -- guard\n"), ...full };
    delete ex[field];
    withException(root, { [rel]: ex });
    const { problems } = checkMigrations(root);
    expect(problems.some((p) => p.includes(`Exception for ${rel} is malformed: missing ${field}`))).toBe(true);
    expect(problems.some((p) => p.includes("Applied migration 002 changed"))).toBe(true);
  });

  it("is harmless when the applied sha256 already matches", () => {
    const root = tree();
    withException(root, { [rel]: { sha256: sha("select 2; -- guard\n"), ...full } });
    expect(checkMigrations(root).problems).toEqual([]);
  });
});

describe("a new migration ships its file set (d)", () => {
  it("passes with release, rollback, verify and a preflight marker", () => {
    const root = tree();
    addNew(root);
    expect(checkMigrations(root)).toEqual({ problems: [], applied: 2, added: ["003_third.sql"] });
  });

  it("names everything that is missing", () => {
    const root = tree();
    write(root, "supabase/migrations/003_third.sql", "select 3;\n");
    const { problems } = checkMigrations(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("New migration 003");
    for (const part of ["release file supabase/release/003_third.release.sql", "rollback file supabase/release/003_third.rollback.sql", "verify file supabase/verify/<name>_003.sql", "preflight marker ('003 ...')"]) {
      expect(problems[0]).toContain(part);
    }
  });

  it.each([
    ["release", "supabase/release/003_third.release.sql", "release file"],
    ["rollback", "supabase/release/003_third.rollback.sql", "rollback file"],
    ["verify", "supabase/verify/third_003.sql", "verify file"],
  ])("names a missing %s file alone", (_k, rel, label) => {
    const root = tree();
    addNew(root);
    unlinkSync(path.join(root, rel));
    const { problems } = checkMigrations(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(label);
    expect(problems[0].match(/ file /g)).toHaveLength(1);
  });

  it("names a missing preflight marker alone (the marker must be this number, not another)", () => {
    const root = tree();
    addNew(root);
    write(root, "supabase/verify/release_preflight.sql", "VALUES\n    ('001 first', true),\n    ('013 other', true)\n");
    const { problems } = checkMigrations(root);
    expect(problems).toEqual([expect.stringContaining("preflight marker ('003 ...')")]);
  });

  it("does not ask for the catalogue snapshot", () => {
    const root = tree();
    addNew(root);
    expect(checkMigrations(root).problems).toEqual([]);
  });
});

describe("command line", () => {
  it("exits 0 and says what it checked", () => {
    const root = tree();
    addNew(root);
    expect(execFileSync("node", [script, root], { encoding: "utf8" })).toContain("2 applied migrations unchanged; 1 new (003)");
  });

  it("exits 1 and prints the message for an edited applied migration", () => {
    const root = tree();
    write(root, "supabase/migrations/002_second.sql", "select 2; -- edited\n");
    let stderr = "";
    let status = 0;
    try {
      execFileSync("node", [script, root], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toContain("Applied migration 002 changed: write a new migration instead");
  });
});

describe("this repository", () => {
  it("passes: nothing applied has changed and every new migration has its file set", () => {
    const r = checkMigrations(repo);
    expect(r.problems).toEqual([]);
    expect(r.applied).toBeGreaterThan(60);
  });

  it("keeps the original applied sha256 for 080 and documents the current one as an exception", () => {
    const j = JSON.parse(readFileSync(path.join(repo, "supabase/applied-migrations.json"), "utf8"));
    expect(j.migrations["080"].migration.sha256).toBe("f66d887a80747849c42137b5df9a4908b7621387e994b264d2f96a3690236de8");
    expect(j.migrations["080"].release.sha256).toBe("94d961fb1a91b87f08fabb5778d7ed37843ab26182cbbf4782e485f0c13c7808");
    expect(Object.keys(j.exceptions).sort()).toEqual([j.migrations["080"].migration.path, j.migrations["080"].release.path].sort());
    for (const x of Object.values(j.exceptions) as { commit: string; production_note: string }[]) {
      expect(x.commit).toBe("a7198394");
      expect(x.production_note).toContain("NOT repasted");
    }
  });

  it("lists 082 with its four files and leaves out what production does not have", () => {
    const m = JSON.parse(readFileSync(path.join(repo, "supabase/applied-migrations.json"), "utf8")).migrations;
    expect(Object.keys(m["082"]).sort()).toEqual(["migration", "release", "rollback", "verify"]);
    for (const n of ["041", "047", "048", "062"]) expect(m[n]).toBeUndefined();
  });
});
