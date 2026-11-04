/**
 * A stand-in CNC costing engine on loopback for the go-live smoke, so the quote builder's real "Price from costing engine" panel
 * (components/costing-line-picker.tsx, through the app's /api/costing proxy) can add a costing line. The app server reaches it via
 * COSTING_ENGINE_URL / COSTING_ENGINE_TOKEN (playwright.golive-smoke.config.ts); the outbound guard allows loopback only.
 *
 * One synthetic part. The unit price is a half-penny tie, 33.335: the picker must round it to the penny half away from zero (33.34),
 * as lib/money.ts and Postgres round(numeric, 2) do. Every call is recorded (GET /__calls) with whether the bearer token matched.
 */
import { createServer, type Server } from "node:http";

export const COSTING_TOKEN = "golive-smoke-costing-token-not-real";
export const COSTING_PORT = Number(process.env.GOLIVE_SMOKE_COSTING_PORT ?? 3997);
export const COSTING_PART = { id: 501, part_number: "SMK-100", description: "Bracket", material_id: 1, operations: [] };
export const COSTING_UNIT_PRICE = 33.335;
export type CostingCall = { method: string; path: string; body: unknown; tokenOk: boolean; org: string | null };

export async function startMockCosting(port: number) {
  const calls: CostingCall[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const send = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (request.method === "GET" && request.url === "/__calls") return send(200, calls);
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const tokenOk = request.headers.authorization === `Bearer ${COSTING_TOKEN}`;
      calls.push({ method: request.method ?? "", path: request.url ?? "", body, tokenOk, org: (request.headers["x-org-id"] as string | undefined) ?? null });
      if (!tokenOk) return send(401, { error: "bad token" });
      if (request.method === "GET" && request.url === "/api/parts") return send(200, [COSTING_PART]);
      if (request.method === "POST" && request.url === "/api/quotes/calculate-detailed") {
        const { part_id, quantity, margin_pct } = (body ?? {}) as { part_id?: number; quantity?: number; margin_pct?: number };
        if (part_id !== COSTING_PART.id || !Number.isInteger(quantity)) return send(422, { error: "bad request" });
        const unit = COSTING_UNIT_PRICE;
        const cost = 27.78;
        return send(200, {
          cost_breakdown: {
            material: { base: 4.1, scrap: 0.4, total: 4.5 }, machine_cost: 12.0, labor_cost: 6.0, tooling_cost: 1.0, programming_cost: 1.5,
            inspection_cost: 0.8, consumables_cost: 0.48, overhead_cost: 1.5, subtotal_cost: cost, unit_cost: cost, margin_amount: unit - cost, unit_price: unit,
          },
          summary: { quantity, unit_cost: cost, unit_price: unit, margin_pct: Math.round((margin_pct ?? 0) * 100), extended_cost: cost * quantity!, extended_price: unit * quantity!, profit_amount: (unit - cost) * quantity! },
          part_info: { part_number: COSTING_PART.part_number, description: COSTING_PART.description, material_name: "EN1A" },
        });
      }
      return send(404, { error: "mock costing: unknown route" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
