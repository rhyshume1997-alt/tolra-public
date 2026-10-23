/** The authorised inspectors list (migration 083): who can be added, the reason and scope limits, and since-when per person. */
import { describe, expect, it } from "vitest";

import { type InspectorChange, currentAuthorisations, eligible, reasonProblem, scopeProblem } from "@/lib/inspectors";

const person = (extra: Partial<Parameters<typeof eligible>[0]> = {}) => ({ id: "u", name: "Sam", roles: ["workshop"], active: true, support: false, inspector: false, ...extra });
const row = (user_id: string, change: "added" | "removed", changed_at: string, reason = "Trained and signed off"): InspectorChange =>
  ({ id: `${user_id}-${changed_at}`, user_id, change, scope: change === "added" ? "Dimensional" : null, reason, changed_by: "admin", changed_at });

describe("inspectors list", () => {
  it("active admin, office and workshop members can be added; viewers, inactive members and Tolra support can't", () => {
    for (const roles of [["admin"], ["office"], ["workshop"], ["viewer", "workshop"]]) expect(eligible(person({ roles })), roles.join("+")).toBe(true);
    expect(eligible(person({ roles: ["viewer"] }))).toBe(false);
    expect(eligible(person({ active: false }))).toBe(false);
    expect(eligible(person({ roles: ["admin"], support: true }))).toBe(false);
  });

  it("a reason is 10 to 500 characters once trimmed (the database's own limits); a scope up to 200", () => {
    expect(reasonProblem("  too short ")).toMatch(/at least 10/); // 9 characters once trimmed
    expect(reasonProblem("  ten chars! ")).toBeNull();
    expect(reasonProblem("x".repeat(500))).toBeNull();
    expect(reasonProblem("x".repeat(501))).toMatch(/500/);
  });

  it("since when: the newest addition per person still on the list; a removal clears it", () => {
    const history = [row("a", "added", "2026-10-01T08:00:00Z"), row("a", "removed", "2026-10-02T08:00:00Z"), row("a", "added", "2026-10-03T08:00:00Z", "Back from the course"),
      row("b", "added", "2026-10-01T09:00:00Z"), row("c", "added", "2026-10-01T10:00:00Z")];
    const current = currentAuthorisations(history, new Set(["a", "b"]));
    expect(current.get("a")?.reason).toBe("Back from the course");
    expect(current.get("b")?.changed_at).toBe("2026-10-01T09:00:00Z");
    expect(current.has("c")).toBe(false); // not on the list any more (changed outside the history's view)
    expect(scopeProblem("x".repeat(200))).toBeNull();
    expect(scopeProblem("x".repeat(201))).toMatch(/200/);
  });
});
