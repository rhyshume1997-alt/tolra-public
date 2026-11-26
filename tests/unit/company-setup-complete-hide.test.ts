// "Set up your company, n of 9 reviewed": hidden behind "Show setup steps" once all 9 are ticked; unchanged below that.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setupGuideView } from "@/components/company-setup-guide";
import { SETUP_STEPS } from "@/lib/company-setup/progress";

describe("setup guide completion", () => {
  it("shows the card below 9 of 9 and hides it at 9 of 9", () => {
    const n = SETUP_STEPS.length;
    expect(n).toBe(9);
    expect(setupGuideView(0, n, false)).toBe("card");
    expect(setupGuideView(n - 1, n, false)).toBe("card");
    expect(setupGuideView(n, n, false)).toBe("compact");
  });
  it("Show setup steps brings it back, and Hide setup steps goes back to compact", () => {
    expect(setupGuideView(9, 9, true)).toBe("card");
    const src = readFileSync("components/company-setup-guide.tsx", "utf8");
    expect(src).toContain("Show setup steps");
    expect(src).toContain("Hide setup steps");
    expect(src).toContain('data-testid="setup-complete"');
  });
  it("a company that has not loaded yet is never treated as complete", () => {
    expect(readFileSync("components/company-setup-guide.tsx", "utf8")).toContain('loaded?.org === org ? setupGuideView(');
  });
});
