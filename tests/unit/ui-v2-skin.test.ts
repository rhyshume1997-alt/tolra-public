// Pins components/ui/ui-v2-skin.tsx: path -> the screen's own existing switch marker; unknown paths map to none; the skin CSS is scoped to html[data-ui-v2].
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uiV2SkinMarker, UI_V2_SKIN_ROUTES } from "@/components/ui/ui-v2-skin";

describe("ui v2 skin", () => {
  it("maps screens to their own switch", () => {
    expect(uiV2SkinMarker("/jobs")).toBe("ui-jobs-v2:on");
    expect(uiV2SkinMarker("/jobs/abc")).toBe("ui-jobs-v2:on");
    expect(uiV2SkinMarker("/quotes")).toBe("ui-quotes-v2:on");
    expect(uiV2SkinMarker("/settings")).toBe("ui-settings-v2:on");
    expect(uiV2SkinMarker("/schedule")).toBe("ui-schedule-v2:on");
    expect(uiV2SkinMarker("/admin/integrations/xero-organisation")).toBe("ui-admin-xero-v2:on");
    expect(uiV2SkinMarker("/admin/integrations")).toBe("ui-admin-integrations-v2:on");
  });
  it("is off for other paths", () => {
    expect(uiV2SkinMarker("/portal")).toBe("");
    expect(uiV2SkinMarker("/jobsx")).toBe("");
    expect(uiV2SkinMarker(null)).toBe("");
  });
  it("every marker is unique per prefix and ends :on", () => {
    for (const [, m] of UI_V2_SKIN_ROUTES) expect(m).toMatch(/^ui-[a-z-]+-v2:on$/);
  });
  it("the navy selection bar keeps readable buttons (white text on translucent, navy on white for Finish)", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const sel = '[data-testid="selection-bar"][data-selected="true"] [data-slot="button"]';
    expect(css).toContain(`${sel} { background: rgba(255, 255, 255, 0.12); color: #fff;`);
    expect(css).toContain(`${sel}[data-variant="finish"] { background: #fff; color: var(--ui-brand`);
  });
  it("every skin rule is scoped to the attribute", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const block = css.slice(css.indexOf("UI V2 SKIN."), css.indexOf("NAVY SELECTION BAR"));
    const selectors = block.split("\n").filter((l) => /^(html|@media)/.test(l));
    expect(selectors.length).toBeGreaterThan(20);
    for (const l of selectors) if (l.startsWith("html")) expect(l).toContain('html[data-ui-v2="on"]');
  });
});
