import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_TOLRA_CAP_PENCE, MAX_TOLRA_CAP_PENCE } from "@/lib/ai-helper/tolra-caps";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

const input = z.object({ organizationId: z.string().uuid(), monthlyCapPence: z.number().int().min(0).max(MAX_TOLRA_CAP_PENCE) }).strict();
const rows = z.array(z.object({ organization_id: z.string().uuid(), monthly_cap_pence: z.number().int().min(0).max(MAX_TOLRA_CAP_PENCE), spent_pence: z.number().int().nonnegative(), reserved_pence: z.number().int().nonnegative() }));
const headers = { "Cache-Control": "no-store" };

// Exactly the same owner, same-origin and MFA guard as the provider-key route.
export async function GET(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const result = await ctx.admin.rpc("ai_helper_tolra_caps");
  const parsed = rows.safeParse(result.data);
  if (result.error || !parsed.success) return jsonError("Could not load company AI limits. The database update may not be ready.", 503);
  const byId = new Map(parsed.data.map(row => [row.organization_id, row]));
  return NextResponse.json({ defaultCapPence: DEFAULT_TOLRA_CAP_PENCE, maximumCapPence: MAX_TOLRA_CAP_PENCE,
    companies: ctx.companies.map(company => ({ organizationId: company.organization_id, name: company.name,
      monthlyCapPence: byId.get(company.organization_id)?.monthly_cap_pence ?? DEFAULT_TOLRA_CAP_PENCE,
      spentPence: byId.get(company.organization_id)?.spent_pence ?? 0, reservedPence: byId.get(company.organization_id)?.reserved_pence ?? 0 })) }, { headers });
}

export async function POST(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = input.safeParse(json.data);
  if (!parsed.success) return jsonError("Choose a company and a whole-pence limit from 0 to 100,000 (£1,000).", 400);
  const { organizationId, monthlyCapPence } = parsed.data;
  if (!ctx.companies.some(company => company.organization_id === organizationId)) return jsonError("Company not found.", 404);
  const { error } = await ctx.admin.rpc("ai_helper_tolra_set_cap", { p_org: organizationId, p_cap_pence: monthlyCapPence, p_owner: ctx.user.id });
  if (error) return jsonError(error.hint === "cap_below_usage"
    ? "The limit cannot be lower than this month's used and reserved AI. Refresh the list and choose a higher limit."
    : "Could not save this company's AI limit.", error.hint === "cap_below_usage" ? 409 : error.code === "42501" ? 403 : 503);
  return NextResponse.json({ organizationId, monthlyCapPence }, { headers });
}
