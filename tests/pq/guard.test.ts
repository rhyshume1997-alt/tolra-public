/**
 * The PQ tooling keeps the repo's isolation guard (tests/support/isolation.ts, verifyBackendIdentity) and only makes it stricter.
 * No database: the identity check is exercised against a recording fake client.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRODUCTION_PROJECT_REFS as REPO_REFS, SYNTHETIC_SLUG_PREFIX as REPO_PREFIX, assertLocalKey as repoLocalKey, assertLoopbackUrl as repoLoopback } from "../support/isolation";
import { CONFIRM_FLAG, PRODUCTION_PROJECT_REFS, PqIsolationError, SYNTHETIC_SLUG_PREFIX, assertConfirmed, assertLocalKey, assertLoopbackUrl, backendFromEnv, verifyDisposableIdentity } from "./seed/guard.mjs";

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const ROOT = path.resolve(__dirname, "../..");

describe("parity with the repo's guard (tests/support/isolation.ts)", () => {
  it("same production refs and same synthetic prefix", () => {
    expect(PRODUCTION_PROJECT_REFS).toEqual(REPO_REFS);
    expect(SYNTHETIC_SLUG_PREFIX).toBe(REPO_PREFIX);
  });

  it("anything the repo's guard refuses, the PQ guard refuses too (and for loopback both accept)", () => {
    const urls = [
      "http://127.0.0.1:54321", "http://localhost:54322", "http://[::1]:54321", "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "https://abc.supabase.co", "https://db.qngvemzbdsvtydkbplpo.supabase.co:5432/postgres", "postgresql://u:p@10.0.0.5:5432/x", "http://example.com", "not a url", "", undefined,
      "http://127.0.0.1.evil.example", "http://localhost.evil.example:3000",
    ];
    for (const url of urls) {
      let repoOk = true; try { repoLoopback("X", url as string); } catch { repoOk = false; }
      let pqOk = true; try { assertLoopbackUrl("X", url as string, {}); } catch { pqOk = false; }
      expect(pqOk, String(url)).toBe(repoOk);
    }
  });

  it("hosted-project keys are refused the same way", () => {
    const hosted = jwt({ role: "service_role", ref: "abcdefghijklmnop" });
    const local = jwt({ role: "service_role", iss: "supabase-demo" });
    expect(() => repoLocalKey("K", hosted)).toThrow();
    expect(() => assertLocalKey("K", hosted)).toThrow(PqIsolationError);
    expect(assertLocalKey("K", local)).toBe(local);
    expect(() => assertLocalKey("K", "nope")).toThrow(/not a JWT/);
    expect(() => assertLocalKey("K", undefined)).toThrow(/not set/);
  });
});

describe("loopback and the disposable CI network", () => {
  it("refuses hosted-looking and remote hosts even if they would be named as disposable", () => {
    const env = { CI: "true", PQ_DISPOSABLE_HOSTS: "db.abc.supabase.co,aws-0.pooler.supabase.com,10.0.0.5,my-db.neon.tech,db" };
    for (const url of ["postgresql://u@db.abc.supabase.co:5432/postgres", "postgresql://u@aws-0-eu.pooler.supabase.com:6543/postgres", "postgresql://u@10.0.0.5:5432/x", "postgresql://u@my-db.neon.tech/x"]) {
      expect(() => assertLoopbackUrl("X", url, env), url).toThrow(PqIsolationError);
    }
    expect(assertLoopbackUrl("X", "postgresql://u@db:5432/postgres", env)).toContain("@db:");
  });

  it("a named CI host is accepted only when CI=true, and only if listed", () => {
    expect(() => assertLoopbackUrl("X", "postgresql://u@db:5432/postgres", { PQ_DISPOSABLE_HOSTS: "db" })).toThrow(/not this machine/);
    expect(() => assertLoopbackUrl("X", "postgresql://u@db:5432/postgres", { CI: "true" })).toThrow(/not this machine/);
    expect(() => assertLoopbackUrl("X", "postgresql://u@other:5432/postgres", { CI: "true", PQ_DISPOSABLE_HOSTS: "db" })).toThrow(/not this machine/);
  });

  it("a production project ref is refused anywhere in the value, even on loopback", () => {
    for (const ref of PRODUCTION_PROJECT_REFS) expect(() => assertLoopbackUrl("X", `http://127.0.0.1:1/${ref}`, {})).toThrow(/production project/);
  });

  it("backendFromEnv needs the database URL; checks the API URL and key only when given", () => {
    expect(() => backendFromEnv({})).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => backendFromEnv({ TEST_DATABASE_URL: "postgresql://postgres@127.0.0.1:1/postgres", TEST_SUPABASE_URL: "https://x.supabase.co" })).toThrow(PqIsolationError);
    expect(() => backendFromEnv({ TEST_DATABASE_URL: "postgresql://postgres@127.0.0.1:1/postgres", TEST_SUPABASE_URL: "http://127.0.0.1:2", TEST_SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: "abc" }) })).toThrow(/hosted project/);
    expect(backendFromEnv({ TEST_DATABASE_URL: "postgresql://postgres@127.0.0.1:1/postgres" }).apiUrl).toBeNull();
  });

  it("the confirmation flag is required", () => {
    expect(() => assertConfirmed([])).toThrow(CONFIRM_FLAG);
    expect(() => assertConfirmed([CONFIRM_FLAG])).not.toThrow();
  });
});

/** A recording fake of the three queries verifyDisposableIdentity makes. */
function fakeDb(over: { migrationsTable?: boolean; orgSlugs?: string[]; foreignUsers?: number } = {}) {
  const { migrationsTable = true, orgSlugs = [], foreignUsers = 0 } = over;
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string, params?: unknown[]) => {
      sql.push(text);
      if (/current_database/.test(text)) return { rows: [{ name: "postgres", version: "16.0" }] };
      if (/to_regclass/.test(text)) return { rows: [{ t: migrationsTable ? "supabase_migrations.schema_migrations" : null }] };
      if (/from supabase_migrations/.test(text)) return { rows: [{ version: "000" }] };
      if (/slug not like/.test(text)) return { rows: orgSlugs.filter((s) => !s.startsWith(String(params?.[0]).replace("%", ""))).map((slug) => ({ slug })) };
      if (/from auth\.users/.test(text)) return { rows: [{ n: foreignUsers }] };
      if (/count\(\*\)::int as n from public\.organizations/.test(text)) return { rows: [{ n: orgSlugs.length }] };
      throw new Error(`unexpected query ${text}`);
    },
  };
}

describe("verifyDisposableIdentity (same refusals as verifyBackendIdentity, plus real auth users)", () => {
  it("accepts an empty database and one holding only synthetic companies", async () => {
    expect((await verifyDisposableIdentity(fakeDb())).organizations).toBe(0);
    expect((await verifyDisposableIdentity(fakeDb({ orgSlugs: ["t-abcdef01-jnr", "t-12345678-alpha"] }))).organizations).toBe(2);
  });
  it("refuses a database with no migrations table (not a Supabase stack)", async () => {
    await expect(verifyDisposableIdentity(fakeDb({ migrationsTable: false }))).rejects.toThrow(/no supabase_migrations/);
  });
  it("refuses a database holding any non-synthetic company", async () => {
    await expect(verifyDisposableIdentity(fakeDb({ orgSlugs: ["t-abcdef01-jnr", "jnr-engineering"] }))).rejects.toThrow(/non-synthetic organisations \(jnr-engineering\)/);
  });
  it("refuses a database holding an auth user outside @example.test", async () => {
    await expect(verifyDisposableIdentity(fakeDb({ foreignUsers: 2 }))).rejects.toThrow(/outside @example\.test/);
  });
  it("makes no write", async () => {
    const db = fakeDb();
    await verifyDisposableIdentity(db);
    expect(db.sql.join("\n")).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate)\b/i);
  });
});

describe("the command line refuses before it connects", () => {
  const run = (script: string, args: string[], env: Record<string, string>) =>
    spawnSync("bash", [path.join(ROOT, "tests/pq", script), ...args], { cwd: ROOT, env: ({ PATH: process.env.PATH ?? "", HOME: os.tmpdir(), ...env }) as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 });
  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync("node", [path.join(ROOT, "tests/pq/seed/cli.mjs"), ...args], { cwd: ROOT, env: ({ PATH: process.env.PATH ?? "", HOME: os.tmpdir(), ...env }) as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 });

  it("setup.sh, reset.sh and verify.sh refuse without the confirmation flag (exit 2, nothing else runs)", () => {
    for (const s of ["setup.sh", "reset.sh", "verify.sh"]) {
      const r = run(s, [], { TEST_DATABASE_URL: "postgresql://postgres@127.0.0.1:1/postgres" });
      expect(r.status, s).toBe(2);
      expect(r.stderr).toContain("--yes-this-is-a-disposable-database");
    }
  });

  it("the CLI refuses a hosted database URL (exit 3) for every command, without opening a connection", () => {
    for (const command of ["identity", "load", "verify", "reset"]) {
      const r = cli([command, CONFIRM_FLAG], { TEST_DATABASE_URL: "postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres" });
      expect(r.status, command).toBe(3);
      expect(r.stderr).toMatch(/looks hosted|not this machine/);
    }
    const prod = cli(["reset", CONFIRM_FLAG], { TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:5432/${PRODUCTION_PROJECT_REFS[0]}` });
    expect(prod.status).toBe(3);
    expect(prod.stderr).toMatch(/production project/);
  });

  it("the CLI refuses a remote IP, a missing URL and a missing flag", () => {
    expect(cli(["load", CONFIRM_FLAG], { TEST_DATABASE_URL: "postgresql://postgres@203.0.113.7:5432/postgres" }).status).toBe(3);
    expect(cli(["load", CONFIRM_FLAG], {}).status).toBe(3);
    expect(cli(["load"], { TEST_DATABASE_URL: "postgresql://postgres@127.0.0.1:1/postgres" }).status).toBe(3);
  });

  it("generate needs no database and no flag, and prints valid JSON", () => {
    const r = cli(["generate", "--base-date", "2026-11-02"], {});
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).meta.baseDate).toBe("2026-11-02");
  });
});
