import { NextResponse } from "next/server";

import { isErrorResponse, requireProfile } from "@/lib/server/auth";

// Tells the quote form whether to show the costing-engine panel. A static route, so it wins over [...path].
export async function GET() {
  const auth = await requireProfile(["admin", "office"]);
  if (isErrorResponse(auth)) return auth;
  const configured = Boolean(process.env.COSTING_ENGINE_URL && process.env.COSTING_ENGINE_TOKEN);
  return NextResponse.json({ configured }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
