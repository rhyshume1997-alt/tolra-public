import { NextResponse } from "next/server";

import { checkAccount, checkTaxRate, parseMappingRequest, usableAccounts, usableTaxRates } from "@/lib/integrations/mappings";
import { companyProvider, xeroReady } from "@/lib/integrations/server";
import { type AccountingProvider, ProviderError } from "@/lib/integrations/types";
import { MAPPING_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/** Xero refused or failed a read: plain words, never a token or Xero's raw answer. */
function xeroReadError(err: unknown) {
  if (err instanceof ProviderError) {
    if (err.outcome === "unauthorized" || err.outcome === "forbidden") return jsonError("Xero needs connecting again before its lists can be read.", 409);
    if (err.outcome === "rate_limited") return jsonError("Xero is busy. Try again in a minute.", 429);
  }
  console.error("[integrations] Xero list read failed:", err instanceof ProviderError ? err.status : "error");
  return jsonError("Couldn't read Xero's accounts and tax rates. Try again.", 502);
}

async function xeroFor(org: string): Promise<{ provider: AccountingProvider } | { response: NextResponse }> {
  const ready = xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return { response: jsonError("Xero is not set up on this server yet.", 503) };
  const provider = await companyProvider(service, org, ready);
  if (!provider) return { response: jsonError("Connect this company to Xero first.", 409) };
  return { provider };
}

/**
 * Admin > Integrations > Mappings: this company's Xero accounts and tax rates, read from Xero on the server (the token never leaves it).
 * Admin only (Rhys, Wed 21 Oct), two-step sign-in as for every admin route.
 */
export async function GET() {
  const auth = await requireProfile([...MAPPING_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // Support access (the platform owner inside a company) holds an admin membership but never changes or reads through this company's Xero:
  // refused before any Xero or database call, as on the Admin > Users routes. The database's connect functions exclude support too.
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  try {
    const xero = await xeroFor(auth.profile.organization_id);
    if ("response" in xero) return xero.response;
    const [accounts, taxRates] = await Promise.all([xero.provider.listAccounts(), xero.provider.listTaxRates()]);
    return NextResponse.json({
      // Only what can be used on sales: revenue accounts; active tax rates that apply to revenue.
      accounts: usableAccounts(accounts).map((a) => ({ code: a.code, name: a.name, type: a.type, revenue: a.revenue })).sort((a, b) => a.code.localeCompare(b.code)),
      taxRates: usableTaxRates(taxRates).map((t) => ({ code: t.code, name: t.name, rate: t.rate, revenue: t.revenue, active: t.active })),
    });
  } catch (err) {
    return xeroReadError(err);
  }
}

/**
 * Saves one mapping: the sales or credit-note account code, or the Xero tax rate for one Tolra VAT rate (a blank code removes it). The
 * code is checked against this company's Xero first: an account must be one of its active revenue accounts, and a tax rate must be active,
 * usable on sales and charge the same percentage as the Tolra rate (20% to 20%; 0%, exempt and no VAT to 0%), or it is refused with the reason. The database then saves it as
 * the signed-in admin (integration_set_mapping: admin and two-step checked again; audited).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...MAPPING_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // Support access (the platform owner inside a company) holds an admin membership but never changes or reads through this company's Xero:
  // refused before any Xero or database call, as on the Admin > Users routes. The database's connect functions exclude support too.
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const body = await readJson(request, 4 * 1024);
  if (!body.ok) return body.response;
  const req = parseMappingRequest(body.data);
  if (!req) return jsonError("Invalid request", 400);

  let name: string | null = null;
  if (req.code) {
    try {
      const xero = await xeroFor(auth.profile.organization_id);
      if ("response" in xero) return xero.response;
      if (req.kind === "tax_rate") {
        const check = checkTaxRate(req.tolraKey, req.code, await xero.provider.listTaxRates());
        if (!check.ok) return jsonError(check.message, 422);
        name = check.rate.name;
      } else {
        const check = checkAccount(req.code, await xero.provider.listAccounts());
        if (!check.ok) return jsonError(check.message, 422);
        name = check.account.name;
      }
    } catch (err) {
      return xeroReadError(err);
    }
  }

  const { error } = await auth.supabase.rpc("integration_set_mapping", {
    p_provider: "xero", p_kind: req.kind, p_tolra_key: req.kind === "tax_rate" ? req.tolraKey : null, p_external_code: req.code || null, p_external_name: name,
  });
  if (error) {
    const hint = (error as { hint?: string }).hint;
    if (error.code === "42501") {
      if (hint === "mfa_required") return jsonError("Confirm your authenticator code first.", 403);
      if (hint === "support_read_only") return jsonError("Support access is read only here, so the mappings can't be changed.", 403);
      return jsonError("Only an admin can change the mappings.", 403);
    }
    if (error.code === "22023") return jsonError(error.message, 400);
    console.error("[integrations] mapping save failed:", error.code ?? "error");
    return jsonError("Couldn't save the mapping. Try again.", 500);
  }
  return NextResponse.json({ kind: req.kind, tolraKey: req.tolraKey, code: req.code || null, name });
}
