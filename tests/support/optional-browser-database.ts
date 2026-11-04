import { existsSync } from "node:fs";
import path from "node:path";

const NAMES = ["TEST_SUPABASE_URL", "TEST_SUPABASE_ANON_KEY", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_DATABASE_URL"] as const;
export const NO_BROWSER_DATABASE = "BLOCKED: no disposable test database configured; see tests/BLOCKED-DATABASE-CHECKS.md.";

/** Only complete absence is optional. Partial/unsafe configuration must fail. */
export function browserDatabaseConfigured(
  env: Record<string, string | undefined> = process.env,
  envFileExists = existsSync(path.resolve(__dirname, "../../.env.test.local")),
) {
  return envFileExists || NAMES.some(name => Boolean(env[name]));
}

export function requireBrowserDatabase(configured: boolean, required = process.env.N1_N6_REQUIRE_DATABASE === "1") {
  if (!configured && required) throw new Error(NO_BROWSER_DATABASE);
}
