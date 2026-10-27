/**
 * The AI admin helper's server-wide switch. OFF unless the env var is exactly "true" (any other value, unset included, is off). Read
 * only on the server: the dashboard layout hands the browser a plain boolean, and the API routes compare the same name themselves
 * before any other work (inline, so the route-guard analyser sees no call before the guard; tests/unit/ai-helper-routes.test.ts checks
 * they use this exact name). Each company also has its own switches (migration 101, Settings > AI helper), all off by default.
 */
export const AI_HELPER_FLAG = "AI_HELPER_ENABLED";

export function aiHelperEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AI_HELPER_FLAG] === "true";
}

/** Roles that may use the helper: office and admin only (the database's functions check the same, migration 101). */
export const AI_HELPER_ROLES = ["admin", "office"] as const;
