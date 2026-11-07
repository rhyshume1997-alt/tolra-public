/**
 * Isolation guard for the PQ tooling. Mirrors tests/support/isolation.ts + verifyBackendIdentity (tests/support/fixtures.ts) and is
 * held to them by tests/pq/guard.test.ts (same production refs, same synthetic prefix, same loopback set). It only ever makes the
 * rules STRICTER: it additionally refuses a database that holds any auth user outside @example.test.
 *
 * Plain ESM so setup.sh / reset.sh can run it with `node` and no build step.
 */
export const PRODUCTION_PROJECT_REFS = ["qngvemzbdsvtydkbplpo", "qtgqliczvyyrkibvxfqv"];
export const SYNTHETIC_SLUG_PREFIX = "t-";
export const CONFIRM_FLAG = "--yes-this-is-a-disposable-database";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const HOSTED_MARKERS = ["supabase.co", "supabase.com", "supabase.in", "pooler.", "vercel", "amazonaws.com", "neon.tech", "azure", "googleapis", "render.com", "railway.app", "fly.dev", "digitalocean"];

export class PqIsolationError extends Error {
  constructor(message) {
    super(`PQ environment refused: ${message}. Use the disposable local stack (npx supabase start / npm run test:backend); never a hosted project.`);
    this.name = "PqIsolationError";
  }
}

/**
 * Loopback only. The one extension is the disposable CI network: hosts named in PQ_DISPOSABLE_HOSTS are accepted only when CI=true,
 * must be bare single-label names, and never anything that looks hosted.
 */
export function assertLoopbackUrl(name, value, env = process.env) {
  if (!value) throw new PqIsolationError(`${name} is not set`);
  const ref = PRODUCTION_PROJECT_REFS.find((r) => value.includes(r));
  if (ref) throw new PqIsolationError(`${name} names production project ${ref}`);
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new PqIsolationError(`${name} is not a URL`);
  }
  const lower = host.toLowerCase();
  if (HOSTED_MARKERS.some((m) => lower.includes(m))) throw new PqIsolationError(`${name} points at ${host}, which looks hosted`);
  if (LOOPBACK_HOSTS.has(host)) return value;
  const extra = String(env.PQ_DISPOSABLE_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.CI === "true" && extra.includes(host) && /^[a-z0-9_-]+$/i.test(host)) return value;
  throw new PqIsolationError(`${name} points at ${host}, not this machine`);
}

/** The key must not belong to a hosted project (hosted Supabase keys carry a `ref` claim). */
export function assertLocalKey(name, value) {
  if (!value) throw new PqIsolationError(`${name} is not set`);
  const parts = value.split(".");
  if (parts.length !== 3) throw new PqIsolationError(`${name} is not a JWT`);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new PqIsolationError(`${name} is not a readable JWT`);
  }
  if (typeof claims.ref === "string") throw new PqIsolationError(`${name} belongs to hosted project ${claims.ref}`);
  return value;
}

export function assertConfirmed(argv) {
  if (!argv.includes(CONFIRM_FLAG)) throw new PqIsolationError(`pass ${CONFIRM_FLAG} to confirm this is a disposable database`);
}

/**
 * Same checks as verifyBackendIdentity (migrations table present; every organisation synthetic) plus: no auth user outside
 * @example.test. Throws before anything is written. `db` is a connected pg Client.
 */
export async function verifyDisposableIdentity(db) {
  const info = await db.query("select current_database() as name, current_setting('server_version') as version");
  const hasMigrations = await db.query("select to_regclass('supabase_migrations.schema_migrations') as t");
  if (!hasMigrations.rows[0].t) throw new PqIsolationError("the database has no supabase_migrations table (not a Supabase stack)");
  const migrations = await db.query("select version from supabase_migrations.schema_migrations order by version");
  const foreign = await db.query("select slug from public.organizations where slug not like $1 limit 3", [`${SYNTHETIC_SLUG_PREFIX}%`]);
  if (foreign.rows.length) throw new PqIsolationError(`the database holds non-synthetic organisations (${foreign.rows.map((r) => r.slug).join(", ")}) so it is not disposable`);
  const realUsers = await db.query("select count(*)::int as n from auth.users where email is not null and email not like '%@example.test'");
  if (realUsers.rows[0].n > 0) throw new PqIsolationError(`the database holds ${realUsers.rows[0].n} auth user(s) outside @example.test so it is not disposable`);
  const orgs = await db.query("select count(*)::int as n from public.organizations");
  return { database: info.rows[0].name, serverVersion: info.rows[0].version, migrations: migrations.rows.map((r) => r.version), organizations: orgs.rows[0].n };
}

/** Connection settings from the environment (or .env.test.local, which scripts/test-backend.sh writes). */
export function backendFromEnv(env = process.env) {
  return {
    databaseUrl: assertLoopbackUrl("TEST_DATABASE_URL", env.TEST_DATABASE_URL, env),
    apiUrl: env.TEST_SUPABASE_URL ? assertLoopbackUrl("TEST_SUPABASE_URL", env.TEST_SUPABASE_URL, env) : null,
    serviceRoleKey: env.TEST_SUPABASE_SERVICE_ROLE_KEY ? assertLocalKey("TEST_SUPABASE_SERVICE_ROLE_KEY", env.TEST_SUPABASE_SERVICE_ROLE_KEY) : null,
  };
}
