import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The pre-issue finance check's switches. Two must both be on:
 *   1. the server switch: OFF unless the env var is exactly "true" (any other value, unset included, is off). Read only on the
 *      server: the dashboard layout hands the browser a plain boolean, and the API routes read the same name themselves before any
 *      other work (they inline the comparison so the route-guard analyser sees no call before the guard;
 *      tests/unit/ai-finance-check-route.test.ts checks they use this exact name).
 *   2. the company's own switch, `ai_helper_settings.finance_check_enabled` (migration 106; off by default; an admin sets it on the AI
 *      page). A database without that column, a company with no settings row, or any read error all mean OFF: the check fails closed.
 */
export const AI_FINANCE_CHECK_FLAG = "AI_FINANCE_CHECK_ENABLED";

export function aiFinanceCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AI_FINANCE_CHECK_FLAG] === "true";
}

/** The column that holds the company's switch. */
export const FINANCE_CHECK_COMPANY_COLUMN = "finance_check_enabled";

/**
 * Reads the company's finance-check switch as the caller (their session and RLS; office and admin may read their own company's row).
 * `available` is false when the database cannot answer (the column does not exist yet, or any error): the switch is then treated as off.
 */
export async function readCompanyFinanceCheck(db: Pick<SupabaseClient, "from">, organizationId: string): Promise<{ available: boolean; enabled: boolean }> {
  const { data, error } = await db.from("ai_helper_settings").select(FINANCE_CHECK_COMPANY_COLUMN).eq("organization_id", organizationId).maybeSingle();
  if (error) return { available: false, enabled: false };
  const value = (data as Record<string, unknown> | null)?.[FINANCE_CHECK_COMPANY_COLUMN];
  return { available: true, enabled: value === true };
}

/** The company's switch alone (the caller still checks the server switch first). */
export async function companyFinanceCheckEnabled(db: Pick<SupabaseClient, "from">, organizationId: string): Promise<boolean> {
  return (await readCompanyFinanceCheck(db, organizationId)).enabled;
}

/** Both switches: the server's env var and the company's own. */
export async function financeCheckAllowed(db: Pick<SupabaseClient, "from">, organizationId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return aiFinanceCheckEnabled(env) && (await companyFinanceCheckEnabled(db, organizationId));
}

/** The answer when the company has the check off: a friendly line and a code the panel uses to hide itself. */
export const FINANCE_CHECK_COMPANY_OFF = { error: "The AI finance check is switched off for this company. An admin can turn it on in the AI section.", code: "company_off" } as const;
