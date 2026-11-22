import { NextResponse } from "next/server";

import { checkRoadmapAction, parseRoadmapList, roadmapRefusal } from "@/lib/platform/roadmap";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

// The platform owner's Roadmap (module F). GET lists the items (and the company names the target picker needs); POST { action: "save" | "move", ... }
// saves one item or moves it one place. Off (404) unless PLATFORM_ROADMAP_ENABLED is exactly "true". Order: flag -> requirePlatformOwner (same origin,
// signed in, is_platform_admin(), aal2) -> a checked body -> ONE call to release 167's platform_roadmap_* function with the owner's OWN session; the
// database checks owner, aal2, read-only support sessions and the target again. The service role is never used here. Nothing is ever deleted.
// Database messages are never returned. Must not change: no AI, no e-mail, no company data is read or written.

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (process.env.PLATFORM_ROADMAP_ENABLED !== "true") return jsonError("Not found", 404); // same rule as roadmapEnabled() in lib/platform/owner-flags.ts, inline because a guard must come first
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const { data, error } = await ctx.supabase.rpc("platform_roadmap_list");
  if (error) {
    console.error("[platform] roadmap list refused", error.code ?? "no-code", error.hint ?? "");
    const refusal = roadmapRefusal(error);
    return NextResponse.json({ error: refusal.status === 500 ? "Couldn't load the roadmap. Try again." : refusal.error, ...(refusal.code ? { code: refusal.code } : {}) }, { status: refusal.status });
  }
  return NextResponse.json({ items: parseRoadmapList(data), companies: ctx.companies.map((c) => ({ organizationId: c.organization_id, name: c.name })) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (process.env.PLATFORM_ROADMAP_ENABLED !== "true") return jsonError("Not found", 404); // same rule as roadmapEnabled() in lib/platform/owner-flags.ts, inline because a guard must come first
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  const checked = checkRoadmapAction(json.data);
  if (!checked.ok) return jsonError(checked.error, 400);
  const action = checked.value;
  const { data, error } = action.action === "move"
    ? await ctx.supabase.rpc("platform_roadmap_move", { p_id: action.id, p_direction: action.direction })
    : await ctx.supabase.rpc("platform_roadmap_save", {
        p_id: action.value.id, p_title: action.value.title, p_description: action.value.description, p_status: action.value.status,
        p_target_kind: action.value.targetKind, p_target_orgs: action.value.targetOrgIds,
      });
  if (error) {
    console.error("[platform] roadmap write refused", error.code ?? "no-code", error.hint ?? "");
    const refusal = roadmapRefusal(error);
    return NextResponse.json({ error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) }, { status: refusal.status });
  }
  const id = data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : null;
  if (!id) return jsonError("Couldn't confirm the change. Reload the list before trying again.", 500);
  console.info(JSON.stringify({ event: "platform.roadmap_changed", action: action.action, actor: ctx.user.id, at: new Date().toISOString() }));
  return NextResponse.json({ ok: true, id }, { headers: NO_STORE });
}
