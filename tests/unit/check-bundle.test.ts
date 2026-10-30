/** scripts/check-bundle.mjs (audit SEC12 fixtures, audit S3 server secrets) against a synthetic .next/static. CI runs it on the real build. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(__dirname, "../../scripts/check-bundle.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A build dir whose static/chunks/app.js holds `text`; runs the script with only `env` (plus PATH and NODE_ENV) set. */
function run(text: string, env: Record<string, string> = {}) {
  const build = mkdtempSync(path.join(tmpdir(), "check-bundle-"));
  dirs.push(build);
  mkdirSync(path.join(build, "static", "chunks"), { recursive: true });
  writeFileSync(path.join(build, "static", "chunks", "app.js"), text);
  const result = spawnSync(process.execPath, [script, build], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...env } });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJlLXN5bnRoZXRpYw`;

describe("check-bundle", () => {
  it("passes a clean bundle, including a client message that only names a variable and the public anon JWT", () => {
    const res = run(`const a="Not sent: no e-mail provider key (RESEND_API_KEY) in this deployment.";const k="${jwt({ role: "anon", iss: "supabase" })}";`);
    expect(res.out).toContain("no server secret");
    expect(res.status).toBe(0);
  });

  it.each([
    ["process.env.SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    ['e.env["CRON_SECRET"]', "CRON_SECRET"],
    ["n.env.AI_HELPER_PROVIDER", "AI_HELPER_PROVIDER"],
    ["process.env.INTEGRATIONS_ENCRYPTION_KEY", "INTEGRATIONS_ENCRYPTION_KEY"],
  ])("fails when browser code reads a server-only variable (%s)", (code, name) => {
    const res = run(`var x=${code};`);
    expect(res.status).toBe(1);
    expect(res.out).toContain(`reads server-only variable ${name}`);
  });

  it("does not flag a NEXT_PUBLIC_ read", () => {
    expect(run("var u=process.env.NEXT_PUBLIC_SUPABASE_URL;").status).toBe(0);
  });

  it("fails on a service_role JWT whatever it is called", () => {
    const res = run(`const k="${jwt({ role: "service_role", iss: "supabase" })}";`);
    expect(res.status).toBe(1);
    expect(res.out).toContain("a service_role JWT");
  });

  it("fails on the value of a secret set in the build environment, without printing the value", () => {
    const value = "re_SyntheticValue_0123456789";
    const res = run(`const t="${value}";`, { RESEND_API_KEY: value, BACKUP_PASSPHRASE: "synthetic-passphrase-unused" });
    expect(res.status).toBe(1);
    expect(res.out).toContain("value of RESEND_API_KEY");
    expect(res.out).not.toContain(value);
    expect(res.out).not.toContain("BACKUP_PASSPHRASE");
  });

  it("does not treat an AI_* setting value as a secret (AI_HELPER_PROVIDER=anthropic)", () => {
    expect(run('const s="Powered by anthropic models";', { AI_HELPER_PROVIDER: "anthropic" }).status).toBe(0);
  });

  it("still fails on the fixture markers (SEC12)", () => {
    const res = run('const p="PN-100";');
    expect(res.status).toBe(1);
    expect(res.out).toContain("test-only fixture content");
  });

  it("exits 2 when there is nothing to scan", () => {
    const build = mkdtempSync(path.join(tmpdir(), "check-bundle-"));
    dirs.push(build);
    expect(spawnSync(process.execPath, [script, build], { encoding: "utf8" }).status).toBe(2);
  });
});
