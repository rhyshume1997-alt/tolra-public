import { NextResponse } from "next/server";

import { NOT_CONFIGURED_CODE, notSetUpMessage } from "@/lib/integrations/overview";

/**
 * The answer of every connect, callback, test and invite route while a provider's app details don't exist yet (they are entered at
 * go-live): a clean 503 with the card's own words and a stable `code`, never a 500. `problem` (optional) names a setting that is wrong
 * when one is set but unusable.
 */
export function notConfiguredResponse(provider: "xero" | "microsoft", problem?: string | null): NextResponse {
  return NextResponse.json({ error: notSetUpMessage(provider), code: NOT_CONFIGURED_CODE, ...(problem ? { problem } : {}) }, { status: 503, headers: { "cache-control": "no-store" } });
}
