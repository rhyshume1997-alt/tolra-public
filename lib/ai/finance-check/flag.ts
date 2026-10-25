/**
 * The pre-issue finance check's server-side switch. OFF unless the env var is exactly "true" (any other value, unset included, is
 * off). Read only on the server: the dashboard layout hands the browser a plain boolean, and the API routes read the same name
 * themselves before any other work (they inline the comparison so the route-guard analyser sees no call before the guard;
 * tests/unit/ai-finance-check-route.test.ts checks they use this exact name).
 *
 * Follow-up (not built here, needs a migration): a per-company admin switch (spec section 1.2, `ai_preissue_check`).
 */
export const AI_FINANCE_CHECK_FLAG = "AI_FINANCE_CHECK_ENABLED";

export function aiFinanceCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AI_FINANCE_CHECK_FLAG] === "true";
}
