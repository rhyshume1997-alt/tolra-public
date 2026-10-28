import "server-only";

import type { CostingDeps } from "@/lib/ai-helper/pricing";
import type { CostingBreakdown, CostingPart } from "@/lib/costing";

/**
 * The costing engine reached from the SERVER for one company, exactly as the /api/costing proxy reaches it
 * (app/api/costing/[...path]/route.ts): COSTING_ENGINE_URL with the shared COSTING_ENGINE_TOKEN and X-Org-Id set to the caller's
 * own company, so the parts, rates and prices are that company's records and no other's. Used by the AI helper's Approve route to
 * price the draft lines itself; the browser's prices are never used. Not configured: every price is blank (configured() is false).
 */
export function serverCostingDeps(organizationId: string, fetcher: typeof fetch = fetch): CostingDeps {
  const engineUrl = process.env.COSTING_ENGINE_URL;
  const token = process.env.COSTING_ENGINE_TOKEN;
  async function call<T>(route: string, body?: unknown): Promise<T> {
    if (!engineUrl || !token) throw new Error("Costing engine not configured");
    const response = await fetcher(`${engineUrl.replace(/\/$/, "")}/api/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-Org-Id": organizationId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Costing engine status ${response.status}`);
    return (await response.json()) as T;
  }
  return {
    configured: async () => Boolean(engineUrl && token),
    parts: () => call<CostingPart[]>("parts"),
    calculate: (partId, quantity, marginPct) => call<CostingBreakdown>("quotes/calculate-detailed", { part_id: partId, quantity, margin_pct: marginPct }),
  };
}
