/**
 * Isolation guard for every test that writes (audit B1: D27, A1, SEC13).
 *
 * Write tests run only against the local disposable Supabase started by scripts/test-backend.sh. The guard refuses
 * anything else before a single request is made: a non-loopback URL, a hosted project's key, a known production
 * project ref, or a database that already holds non-synthetic tenants. A missing backend is a failure, never a skip
 * and never a reason to fall back to another database.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Hosted Supabase projects that must never receive test traffic (production and the legacy production project). */
export const PRODUCTION_PROJECT_REFS = ["qngvemzbdsvtydkbplpo", "qtgqliczvyyrkibvxfqv"];

/** Every synthetic organisation slug starts with this; a database holding any other slug is not disposable. */
export const SYNTHETIC_SLUG_PREFIX = "t-";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type IsolatedBackend = {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  databaseUrl: string;
};

export class IsolationError extends Error {
  constructor(message: string) {
    super(`Isolated test backend required: ${message}. Start one with \`npm run test:backend\` (Docker); never point tests at a hosted project.`);
    this.name = "IsolationError";
  }
}

function mentionsProduction(value: string) {
  return PRODUCTION_PROJECT_REFS.find((ref) => value.includes(ref)) ?? null;
}

/** Throws unless `value` is an http(s)/postgres URL on a loopback host that names no production project. */
export function assertLoopbackUrl(name: string, value: string | undefined): string {
  if (!value) throw new IsolationError(`${name} is not set`);
  const ref = mentionsProduction(value);
  if (ref) throw new IsolationError(`${name} names production project ${ref}`);
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new IsolationError(`${name} is not a URL`);
  }
  if (!LOOPBACK_HOSTS.has(host)) throw new IsolationError(`${name} points at ${host}, not this machine`);
  return value;
}

/** Hosted Supabase keys carry a `ref` claim naming their project; the local stack's keys don't. */
export function assertLocalKey(name: string, value: string | undefined): string {
  if (!value) throw new IsolationError(`${name} is not set`);
  const parts = value.split(".");
  if (parts.length !== 3) throw new IsolationError(`${name} is not a JWT`);
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new IsolationError(`${name} is not a readable JWT`);
  }
  if (typeof claims.ref === "string") throw new IsolationError(`${name} belongs to hosted project ${claims.ref}`);
  return value;
}

/** Values from the environment, else from .env.test.local (written by scripts/test-backend.sh). */
function readEnv(): Record<string, string | undefined> {
  const file = path.resolve(__dirname, "../../.env.test.local");
  const fromFile: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) fromFile[match[1]] = match[2];
    }
  }
  return { ...fromFile, ...process.env };
}

/** The disposable backend's coordinates, or an IsolationError explaining what is wrong. */
export function isolatedBackend(): IsolatedBackend {
  const env = readEnv();
  return {
    apiUrl: assertLoopbackUrl("TEST_SUPABASE_URL", env.TEST_SUPABASE_URL),
    anonKey: assertLocalKey("TEST_SUPABASE_ANON_KEY", env.TEST_SUPABASE_ANON_KEY),
    serviceRoleKey: assertLocalKey("TEST_SUPABASE_SERVICE_ROLE_KEY", env.TEST_SUPABASE_SERVICE_ROLE_KEY),
    databaseUrl: assertLoopbackUrl("TEST_DATABASE_URL", env.TEST_DATABASE_URL),
  };
}

export function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}
