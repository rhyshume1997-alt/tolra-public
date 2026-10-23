import { describe, expect, it } from "vitest";

import { canOpenDestination } from "@/lib/destinations";
import { NAV_TOGGLES } from "@/lib/org-settings";

describe("Settings > Menu Sections", () => {
  it("offers Weekly hours (/time) beside the other Operations pages, and hiding it hides the link", () => {
    expect(NAV_TOGGLES.find((item) => item.href === "/time")).toMatchObject({ key: "time", label: "Weekly hours", section: "Operations" });
    expect(canOpenDestination("/time", { activeRole: "workshop", hiddenSections: [], hiddenNav: [] })).toBe(true);
    expect(canOpenDestination("/time", { activeRole: "workshop", hiddenSections: [], hiddenNav: ["time"] })).toBe(false);
  });
});
