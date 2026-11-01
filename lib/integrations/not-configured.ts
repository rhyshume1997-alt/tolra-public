import { NextResponse } from "next/server";

import { NOT_CONFIGURED_CODE, notSetUpMessage } from "@/lib/integrations/overview";

/**
 * The answer of every connect, callback, test and invite route while a provider's app details don't exist yet (they are entered at
 * go-live): a clean 503 with the card's own words and a stable `code`, never a 500. Exactly { error, code }: never a setting's name,
 * a client id, a secret or a URL (a setting that is set but unusable is logged on the server by the route, not answered).
 */
export function notConfiguredResponse(provider: "xero" | "microsoft"): NextResponse {
  return NextResponse.json({ error: notSetUpMessage(provider), code: NOT_CONFIGURED_CODE }, { status: 503, headers: { "cache-control": "no-store" } });
}
