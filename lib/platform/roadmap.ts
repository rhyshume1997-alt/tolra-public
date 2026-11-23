// Platform owner Roadmap (module F). Inputs: the raw JSON body of POST /api/platform/roadmap, and what release 167's roadmap functions return.
// Outputs: a checked input, whitelisted rows, fixed-wording refusals. Must not change: no database message is ever shown to the caller; nothing here
// writes (the route calls release 167's functions with the owner's own session, and the database checks the owner, the second step and the target
// again); the four statuses and three targets match the database constraints; pure (no React, no I/O).

export const ROADMAP_STATUSES = ["idea", "planned", "building", "shipped"] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];
export const ROADMAP_STATUS_LABEL: Record<RoadmapStatus, string> = { idea: "Idea", planned: "Planned", building: "Building", shipped: "Shipped" };
export const ROADMAP_TARGETS = ["one", "few", "all"] as const;
export type RoadmapTarget = (typeof ROADMAP_TARGETS)[number];
export const ROADMAP_TARGET_LABEL: Record<RoadmapTarget, string> = { one: "One company", few: "A chosen few", all: "All companies" };
export const ROADMAP_TITLE_MAX = 120;
export const ROADMAP_DESCRIPTION_MAX = 1000;
export const ROADMAP_FEW_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RoadmapItem = {
  id: string; title: string; description: string; status: RoadmapStatus; sortOrder: number;
  targetKind: RoadmapTarget; targetOrgIds: string[]; createdAt: string; shippedAt: string | null;
};
export type RoadmapSave = { id: string | null; title: string; description: string; status: RoadmapStatus; targetKind: RoadmapTarget; targetOrgIds: string[] };
export type RoadmapAction = { action: "save"; value: RoadmapSave } | { action: "move"; id: string; direction: "up" | "down" };
export type RoadmapCheck = { ok: true; value: RoadmapAction } | { ok: false; error: string };

const bad = (error: string): RoadmapCheck => ({ ok: false, error });

/** Checks a save or move request. Unknown keys are refused. The target must match its kind: all = none, one = exactly one, few = 2 to 50. */
export function checkRoadmapAction(body: unknown): RoadmapCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Send a roadmap request.");
  const b = body as Record<string, unknown>;
  if (b.action === "move") {
    const { id, direction } = b;
    if (Object.keys(b).some((k) => !["action", "id", "direction"].includes(k)) || typeof id !== "string" || !UUID.test(id) || (direction !== "up" && direction !== "down")) return bad("Choose an item and a direction.");
    return { ok: true, value: { action: "move", id: id.toLowerCase(), direction } };
  }
  if (b.action !== "save") return bad("Send a roadmap request.");
  const { id, title, description, status, targetKind, targetOrgIds } = b;
  if (Object.keys(b).some((k) => !["action", "id", "title", "description", "status", "targetKind", "targetOrgIds"].includes(k))) return bad("Send a roadmap request.");
  if (id !== undefined && id !== null && (typeof id !== "string" || !UUID.test(id))) return bad("Choose an item from the list.");
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) return bad("Give the item a title.");
  if (t.length > ROADMAP_TITLE_MAX) return bad(`Keep the title to ${ROADMAP_TITLE_MAX} characters or fewer.`);
  const d = typeof description === "string" ? description.trim() : "";
  if (description !== undefined && typeof description !== "string") return bad("The description must be text.");
  if (d.length > ROADMAP_DESCRIPTION_MAX) return bad(`Keep the description to ${ROADMAP_DESCRIPTION_MAX} characters or fewer.`);
  if (!ROADMAP_STATUSES.includes(status as RoadmapStatus)) return bad("Choose a status.");
  if (!ROADMAP_TARGETS.includes(targetKind as RoadmapTarget)) return bad("Choose who it is for.");
  const raw = targetOrgIds === undefined ? [] : targetOrgIds;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !UUID.test(x))) return bad("Choose companies from the list.");
  const orgs = raw.map((x) => (x as string).toLowerCase());
  if (new Set(orgs).size !== orgs.length) return bad("Each company can be chosen once.");
  if (targetKind === "all" && orgs.length !== 0) return bad("All companies means none are picked one by one.");
  if (targetKind === "one" && orgs.length !== 1) return bad("Choose exactly one company.");
  if (targetKind === "few" && (orgs.length < 2 || orgs.length > ROADMAP_FEW_MAX)) return bad(`Choose from 2 to ${ROADMAP_FEW_MAX} companies.`);
  return { ok: true, value: { action: "save", value: { id: typeof id === "string" ? id.toLowerCase() : null, title: t, description: d, status: status as RoadmapStatus, targetKind: targetKind as RoadmapTarget, targetOrgIds: orgs } } };
}

/** The database's list, whitelisted; a row of the wrong shape is dropped. */
export function parseRoadmapList(data: unknown): RoadmapItem[] {
  if (!Array.isArray(data)) return [];
  const out: RoadmapItem[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.sort_order !== "number" || typeof r.created_at !== "string") continue;
    if (!ROADMAP_STATUSES.includes(r.status as RoadmapStatus) || !ROADMAP_TARGETS.includes(r.target_kind as RoadmapTarget)) continue;
    out.push({
      id: r.id, title: r.title, description: typeof r.description === "string" ? r.description : "", status: r.status as RoadmapStatus, sortOrder: r.sort_order,
      targetKind: r.target_kind as RoadmapTarget, targetOrgIds: Array.isArray(r.target_orgs) ? r.target_orgs.filter((x): x is string => typeof x === "string") : [],
      createdAt: r.created_at, shippedAt: typeof r.shipped_at === "string" ? r.shipped_at : null,
    });
  }
  return out;
}

export type RoadmapRefusal = { status: number; error: string; code?: string };

/** Fixed wording for what the database refused. */
export function roadmapRefusal(error: { code?: string | null; hint?: string | null } | null | undefined): RoadmapRefusal {
  if (error?.code === "42501") {
    if (error.hint === "mfa_required") return { status: 403, code: "mfa_required", error: "Confirm your authenticator code first." };
    if (error.hint === "support_read_only") return { status: 403, error: "A read-only support session cannot do this." };
    return { status: 403, error: "Forbidden" };
  }
  if (error?.code === "P0002") return { status: 404, error: "That roadmap item no longer exists. Reload the list." };
  if (error?.code === "22023") return { status: 400, error: "Check the title, status and who it is for." };
  return { status: 500, error: "Couldn't save the roadmap. Nothing was changed; try again." };
}
