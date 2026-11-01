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

/**
 * G3, the in-app assistant: its own server-wide switch, OFF unless exactly "true", on top of AI_HELPER_ENABLED (both must be on). So
 * turning the round-up or RFQ helper on for a server never makes the assistant reachable. The route compares the same name inline,
 * before any other work. Each company also has its own switch (migration 133, ai_helper_settings.assistant_enabled, off by default,
 * admin only), and the database refuses to reserve an assistant request while that is off.
 */
export const AI_ASSISTANT_FLAG = "AI_ASSISTANT_ENABLED";

export function aiAssistantEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return aiHelperEnabled(env) && env[AI_ASSISTANT_FLAG] === "true";
}
