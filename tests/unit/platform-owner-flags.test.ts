/**
 * Owner-only Roadmap and Rollouts flags (lib/platform/owner-flags.ts). Proves both are OFF unless the variable is exactly "true", and that
 * the two are independent. Must not change: unset means off.
 */
import { describe, expect, it } from "vitest";

import { roadmapEnabled, rolloutsEnabled } from "@/lib/platform/owner-flags";

describe("platform owner flags", () => {
  it("are off when unset", () => {
    expect(roadmapEnabled({})).toBe(false);
    expect(rolloutsEnabled({})).toBe(false);
  });
  it("are on only for exactly \"true\"", () => {
    for (const v of ["1", "TRUE", "True", " true", "true ", "yes", "on", ""]) {
      expect(roadmapEnabled({ PLATFORM_ROADMAP_ENABLED: v }), v).toBe(false);
      expect(rolloutsEnabled({ PLATFORM_ROLLOUTS_ENABLED: v }), v).toBe(false);
    }
    expect(roadmapEnabled({ PLATFORM_ROADMAP_ENABLED: "true" })).toBe(true);
    expect(rolloutsEnabled({ PLATFORM_ROLLOUTS_ENABLED: "true" })).toBe(true);
  });
  it("are independent of each other", () => {
    expect(roadmapEnabled({ PLATFORM_ROLLOUTS_ENABLED: "true" })).toBe(false);
    expect(rolloutsEnabled({ PLATFORM_ROADMAP_ENABLED: "true" })).toBe(false);
  });
});
