/**
 * BOUNDARY: GET /api/platform/owner-home (Owner Home, module 12). Input: the request. Output: { enabled: false } while the switch is
 * off, otherwise { enabled: true, ...OwnerHomeData }. Order: requirePlatformOwner (same origin, signed in, platform owner, second step)
 * first, so a non-owner never learns the screen exists; then the switch; then reads only, through the owner's own session.
 * No database message reaches the caller. Must not change: the guard, or write anything.
 */
import { NextResponse } from "next/server";

import { jsonError } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";
import { loadOwnerHome, parseListRows } from "@/lib/platform/owner-home/counts";
import { ownerHomeEnabled } from "@/lib/platform/owner-home/flag";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requirePlatformOwner(request);
  if (guard instanceof NextResponse) return guard;
  if (!ownerHomeEnabled()) return NextResponse.json({ enabled: false });
  try {
    const data = await loadOwnerHome(guard.supabase, parseListRows(guard.companies));
    return NextResponse.json({ enabled: true, ...data });
  } catch {
    console.error("[platform] owner home failed");
    return jsonError("Couldn't load the home screen. Try again.", 500);
  }
}
