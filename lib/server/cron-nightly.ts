/**
 * Inputs: settled sub-task result from /api/cron/nightly (HTTP status, parsed body, and JSON validity flag).
 * Outputs: boolean indicating whether the sub-task was unsuccessful and should fail the nightly scheduler with HTTP 500.
 * Boundary: Module 6 (Scheduled Cron Tasks) only; preserves HTTP 200 for intentional migration-skip responses (`{ skipped: "not configured" }`).
 */
export type NightlySubtaskResult = {
  status: number;
  body: unknown;
  invalidJson?: boolean;
};

/**
 * Returns true whenever a nightly sub-task did not succeed:
 * - any non-2xx HTTP status (including 4xx such as 401/403/429 and 5xx)
 * - an unparseable / non-JSON response body
 * - a JSON object carrying a non-empty `error` string
 */
export function isNightlyTaskFailure(result: NightlySubtaskResult): boolean {
  if (result.status < 200 || result.status >= 300) return true;
  if (result.invalidJson) return true;
  if (result.body && typeof result.body === "object" && "error" in result.body) {
    const err = (result.body as { error?: unknown }).error;
    if (typeof err === "string" && err.trim().length > 0) return true;
  }
  return false;
}
