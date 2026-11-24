/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW). Inputs: the QUOTE_LIVE_PREVIEW_ENABLED and VERCEL_ENV values. Output: whether /quotes/preview-live may open.
 * The route is OFF BY DEFAULT: it opens only when QUOTE_LIVE_PREVIEW_ENABLED is exactly "true" AND VERCEL_ENV is exactly "preview" (Vercel sets "preview" on branch and scratch builds,
 * "production" on production deployments, and nothing locally). Every other value, including unset, closes it (the page then returns notFound()).
 * Must not change: the exact-match comparisons; no other value may open the route; tests/unit/quotesLiveGuard.test.ts pins the full truth table and that the page uses this gate.
 */
export const QUOTE_LIVE_FLAG = "QUOTE_LIVE_PREVIEW_ENABLED";

export function isProductionDeployment(env: string | undefined = process.env.VERCEL_ENV): boolean {
  return env === "production";
}

export function quoteLivePreviewOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env.QUOTE_LIVE_PREVIEW_ENABLED === "true" && env.VERCEL_ENV === "preview";
}
