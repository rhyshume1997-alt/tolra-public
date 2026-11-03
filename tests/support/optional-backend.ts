import { existsSync } from "node:fs";
import path from "node:path";
import { isolatedBackend } from "./isolation";

/** Only a wholly absent backend may skip. Invalid/partial/hosted settings still throw. */
export function optionalBackendConfigured(): boolean {
  const supplied = existsSync(path.resolve(__dirname, "../../.env.test.local")) ||
    ["TEST_SUPABASE_URL", "TEST_SUPABASE_ANON_KEY", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_DATABASE_URL"].some((key) => !!process.env[key]);
  if (!supplied) return false;
  isolatedBackend();
  return true;
}
