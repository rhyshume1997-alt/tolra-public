import "server-only";

import { reportServerError } from "@/lib/server/error-alert";

/** The most a cron waits for its own skip alert. */
export const ALERT_GIVE_UP_MS = 3000;

/**
 * A critical cron job that finds its migration missing answers 200 "skipped" (so Vercel does not retry it), which used to be silent:
 * nobody learned that, for example, the nightly purge had never run. This sends the existing production alert once (reportServerError:
 * production only, one e-mail per fingerprint per hour) with a fixed, non-secret message, and changes nothing else: same status, same JSON,
 * so pre-release behaviour is unchanged. Never throws.
 */
export async function alertMissingMigration(route: string, job: string, reason: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const alert = reportServerError({ route, error: new Error(`Cron skipped: ${job}: ${reason}. A required database update is not applied; the job did not run.`), source: "cron" });
    // A stalled mail provider or budget lookup must not hold the cron (up to 8 s + 2 s per alert): give up after ALERT_GIVE_UP_MS. The alert may still finish in the background.
    const giveUp = new Promise<void>((resolve) => { timer = setTimeout(resolve, ALERT_GIVE_UP_MS); });
    await Promise.race([alert.then(() => undefined), giveUp]);
  } catch {
    /* an alert failure must never change the cron's answer */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The "skipped" reason when a pass result says a database update is missing ("database update 108 not applied", "(release 149)"); null for "not configured" skips. */
export function migrationSkipReason(result: unknown): string | null {
  const skipped = typeof result === "object" && result !== null && "skipped" in result ? (result as { skipped?: unknown }).skipped : null;
  return typeof skipped === "string" && /database update \d+|\(release \d+\)/i.test(skipped) ? skipped : null;
}

/** alertMissingMigration when `result` is a migration skip; returns the result unchanged. */
export async function alertIfMigrationSkip<T>(route: string, job: string, result: T): Promise<T> {
  const reason = migrationSkipReason(result);
  if (reason) await alertMissingMigration(route, job, reason);
  return result;
}
