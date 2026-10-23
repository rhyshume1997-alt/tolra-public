import { NextResponse } from "next/server";
import { z } from "zod";

import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";

// Server-side bridge to the CNC costing engine (services/costing-engine).
// The browser never talks to the engine directly: requests are authenticated against Supabase here,
// restricted to the read/calculate endpoints the app needs, scoped to the caller's organisation via
// X-Org-Id, and forwarded with the shared COSTING_ENGINE_TOKEN.

const ALLOWED_ROUTES: Record<string, "GET" | "POST"> = {
  parts: "GET",
  materials: "GET",
  machines: "GET",
  "quotes/calculate-detailed": "POST",
};

const MAX_BODY_BYTES = 10 * 1024;

const calculateSchema = z.object({
  part_id: z.number().int().positive(),
  quantity: z.number().int().min(1).max(1_000_000),
  margin_pct: z.number().min(0).max(5).default(0.15),
});

/** Never relay upstream error text: map to fixed messages by status. */
function upstreamError(status: number) {
  if (status === 400 || status === 422) return jsonError("Invalid request", 400);
  if (status === 404) return jsonError("Not found", 404);
  if (status === 429) return jsonError("Too many requests", 429);
  return jsonError("Costing engine unavailable", 502);
}

async function forward(request: Request, path: string[], method: "GET" | "POST") {
  if (method === "POST" && !sameOrigin(request)) return forbiddenOrigin();

  const auth = await requireProfile(["admin", "office"]);
  if (isErrorResponse(auth)) return auth;
  const { profile } = auth;

  const engineUrl = process.env.COSTING_ENGINE_URL;
  const token = process.env.COSTING_ENGINE_TOKEN;
  if (!engineUrl || !token) return jsonError("Costing engine not configured", 503);

  const route = path.join("/");
  if (ALLOWED_ROUTES[route] !== method) return jsonError("Not found", 404);

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-Org-Id": profile.organization_id,
  };

  let body: string | undefined;
  if (method === "POST") {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_BODY_BYTES) return jsonError("Payload too large", 413);
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return jsonError("Payload too large", 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return jsonError("Invalid request", 400);
    }
    const parsed = calculateSchema.safeParse(raw);
    if (!parsed.success) return jsonError("Invalid request", 400);
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(parsed.data);
  }

  try {
    const response = await fetch(`${engineUrl.replace(/\/$/, "")}/api/${route}`, {
      method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error("[costing] upstream status", response.status);
      return upstreamError(response.status);
    }
    const payload = await response.json().catch(() => null);
    if (payload === null) return jsonError("Costing engine unavailable", 502);
    return NextResponse.json(payload, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError("Costing engine unavailable", 502);
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path, "GET");
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path, "POST");
}
