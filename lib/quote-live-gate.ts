/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW). Input: the VERCEL_ENV value. Output: whether this is a production deployment.
 * Vercel sets VERCEL_ENV to "production" on production deployments, "preview" on branch and scratch builds, and it is unset locally.
 * Must not change: only the exact value "production" closes the live route; tests/unit/quotesLiveGuard.test.ts pins this and that the page uses it.
 */
export function isProductionDeployment(env: string | undefined = process.env.VERCEL_ENV): boolean {
  return env === "production";
}
