import { NextResponse } from "next/server";

import { beginAppTest } from "@/lib/integrations/app-test";
import { microsoftReady } from "@/lib/integrations/microsoft/client";
import { notConfiguredResponse } from "@/lib/integrations/not-configured";
import { xeroReady } from "@/lib/integrations/server";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

export const dynamic = "force-dynamic";

/**
 * Platform > App connections > "Test connection": POST { provider } -> the provider's sign-in URL for a real round trip with the platform
 * owner's own account (authorize, callback, token, one read). Platform owner only, two-step (requirePlatformOwner). The state is a signed,
 * expiring, one-use `app_test` state: the callback stores nothing for any company and drops the tokens. No app details yet: a clean 503.
 */
export async function POST(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const provider = (json.data as { provider?: unknown } | null)?.provider;
  if (provider !== "xero" && provider !== "microsoft") return jsonError("Choose Xero or Microsoft 365.", 400);
  if (provider === "xero") {
    const ready = await xeroReady(process.env, ctx.admin);
    if (!ready) return notConfiguredResponse("xero");
    return NextResponse.json({ url: beginAppTest("xero", ready, ctx.user.id) }, { headers: { "cache-control": "no-store" } });
  }
  const ready = await microsoftReady(ctx.admin);
  if (!ready) return notConfiguredResponse("microsoft");
  return NextResponse.json({ url: beginAppTest("microsoft", ready, ctx.user.id) }, { headers: { "cache-control": "no-store" } });
}
