/**
 * Roadmap input checks, list parsing and refusal wording (lib/platform/roadmap.ts). Proves: a save needs a title, a valid status and a target that
 * matches its kind (all = none, one = exactly one, few = 2 to 50 distinct companies); unknown keys and bad ids are refused; a move needs an id and
 * up or down; the list keeps only well-formed rows; database refusals get fixed wording and never carry a database message.
 */
import { describe, expect, it } from "vitest";

import { checkRoadmapAction, parseRoadmapList, roadmapRefusal } from "@/lib/platform/roadmap";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const base = { action: "save", title: "Faster job board", description: "Load the board in one call", status: "planned", targetKind: "all", targetOrgIds: [] };

describe("checkRoadmapAction (save)", () => {
  it("accepts all, one and a chosen few, and trims text", () => {
    expect(checkRoadmapAction({ ...base, title: "  Faster job board " })).toMatchObject({ ok: true, value: { action: "save", value: { id: null, title: "Faster job board", targetKind: "all", targetOrgIds: [] } } });
    expect(checkRoadmapAction({ ...base, targetKind: "one", targetOrgIds: [A] }).ok).toBe(true);
    expect(checkRoadmapAction({ ...base, targetKind: "few", targetOrgIds: [A, B] }).ok).toBe(true);
    expect(checkRoadmapAction({ ...base, id: A.toUpperCase() })).toMatchObject({ ok: true, value: { value: { id: A } } });
  });
  it("refuses a target that does not match its kind", () => {
    expect(checkRoadmapAction({ ...base, targetKind: "all", targetOrgIds: [A] }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, targetKind: "one", targetOrgIds: [] }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, targetKind: "one", targetOrgIds: [A, B] }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, targetKind: "few", targetOrgIds: [A] }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, targetKind: "few", targetOrgIds: [A, A] }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, targetKind: "few", targetOrgIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }).ok).toBe(false);
  });
  it("refuses a missing or long title, long description, bad status, bad kind, bad ids and unknown keys", () => {
    expect(checkRoadmapAction({ ...base, title: "   " }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, title: "x".repeat(121) }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, description: "x".repeat(1001) }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, description: 5 }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, status: "done" }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, targetKind: "some" }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, targetKind: "one", targetOrgIds: ["nope"] }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, id: "nope" }).ok).toBe(false);
    expect(checkRoadmapAction({ ...base, extra: 1 }).ok).toBe(false);
    for (const v of [null, undefined, "x", 3, [], {}, { action: "delete" }]) expect(checkRoadmapAction(v).ok, String(v)).toBe(false);
  });
  it("allows a description to be left out", () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest.description;
    expect(checkRoadmapAction(rest)).toMatchObject({ ok: true, value: { value: { description: "" } } });
  });
});

describe("checkRoadmapAction (move)", () => {
  it("accepts up and down for a real id only", () => {
    expect(checkRoadmapAction({ action: "move", id: A, direction: "up" })).toEqual({ ok: true, value: { action: "move", id: A, direction: "up" } });
    expect(checkRoadmapAction({ action: "move", id: A, direction: "down" }).ok).toBe(true);
    expect(checkRoadmapAction({ action: "move", id: A, direction: "sideways" }).ok).toBe(false);
    expect(checkRoadmapAction({ action: "move", id: "x", direction: "up" }).ok).toBe(false);
    expect(checkRoadmapAction({ action: "move", id: A, direction: "up", extra: 1 }).ok).toBe(false);
  });
});

describe("parseRoadmapList and roadmapRefusal", () => {
  it("keeps well-formed rows in the database's order and drops the rest", () => {
    const good = { id: A, title: "T", description: "d", status: "shipped", sort_order: 1, target_kind: "one", target_orgs: [B], created_at: "2026-11-01T10:00:00Z", shipped_at: "2026-11-20T10:00:00Z" };
    const rows = parseRoadmapList([good, { ...good, id: B, status: "bogus" }, null, { id: 1 }, { ...good, id: B, shipped_at: null, status: "idea", target_kind: "all", target_orgs: [] }]);
    expect(rows.map((r) => r.id)).toEqual([A, B]);
    expect(rows[0]).toMatchObject({ status: "shipped", targetKind: "one", targetOrgIds: [B], shippedAt: "2026-11-20T10:00:00Z", createdAt: "2026-11-01T10:00:00Z" });
    expect(rows[1].shippedAt).toBeNull();
    expect(parseRoadmapList("x")).toEqual([]);
    expect(parseRoadmapList(null)).toEqual([]);
  });
  it("gives fixed wording and never a database message", () => {
    expect(roadmapRefusal({ code: "42501", hint: "support_read_only" }).status).toBe(403);
    expect(roadmapRefusal({ code: "42501", hint: "mfa_required" })).toMatchObject({ status: 403, code: "mfa_required" });
    expect(roadmapRefusal({ code: "42501" })).toEqual({ status: 403, error: "Forbidden" });
    expect(roadmapRefusal({ code: "P0002" }).status).toBe(404);
    expect(roadmapRefusal({ code: "22023" }).status).toBe(400);
    expect(roadmapRefusal({ code: "XX000" }).status).toBe(500);
    expect(roadmapRefusal(null).status).toBe(500);
    expect(JSON.stringify(roadmapRefusal({ code: "XX000", hint: "secret detail" }))).not.toContain("secret");
  });
});
