/**
 * Runs `fn`, retrying only when Postgres reports a deadlock (40P01) or a lock timeout (55P03), up to `attempts`
 * times in total with a short growing pause. Any other error, or the last failed attempt, is thrown unchanged.
 * Test support only (fault-injection clean-up in tests/e2e/helpers.ts).
 */
export const LOCK_CONFLICT_CODES = ["40P01", "55P03"];

export async function retryOnLockConflict<T>(fn: () => Promise<T>, attempts = 5, pauseMs = 250): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= attempts || !LOCK_CONFLICT_CODES.includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}
