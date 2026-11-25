// Pins components/ui/ui-v2-skin.tsx: path -> the screen's own existing switch marker; unknown paths map to none; the skin CSS is scoped to html[data-ui-v2].
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyUiV2Skin, uiV2SkinMarker, uiV2SkinRoute, UI_V2_SKIN_ROUTES } from "@/components/ui/ui-v2-skin";

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
    for (const { marker: m } of UI_V2_SKIN_ROUTES) expect(m).toMatch(/^ui-[a-z-]+-v2:on$/);
  });
  it("the navy selection bar keeps readable buttons (white text on translucent, navy on white for Finish)", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const sel = 'html[data-ui-v2="on"] [data-testid="selection-bar"][data-selected="true"] [data-slot="button"]';
    expect(css).toContain(`${sel}, ${sel.replace('[data-slot="button"]', '[data-slot="dropdown-menu-trigger"]')} { background: rgba(255, 255, 255, 0.12); color: #fff;`);
    expect(css).toContain(`${sel}[data-variant="finish"] { background: #fff; color: var(--ui-brand`);
  });
  it("dashboard matches exactly; reports is mapped with its second marker", () => {
    expect(uiV2SkinMarker("/dashboard")).toBe("ui-dashboard-v2:on");
    expect(uiV2SkinMarker("/dashboard/anything")).toBe("");
    expect(uiV2SkinMarker("/reports")).toBe("ui-reports-v2:on");
    expect(uiV2SkinRoute("/reports")?.requires).toBe("reports:on");
    expect(uiV2SkinRoute("/jobs")?.requires).toBeUndefined();
  });
  it("applying then removing leaves <html> exactly as it was (no leak between ON and OFF screens)", () => {
    const root = { classList: new Set<string>(["h-full", "antialiased"]) as unknown as DOMTokenList, attrs: new Map<string, string>() };
    const set = root.classList as unknown as Set<string>;
    const fake = {
      classList: { add: (...c: string[]) => c.forEach((x) => set.add(x)), remove: (...c: string[]) => c.forEach((x) => set.delete(x)) },
      setAttribute: (k: string, v: string) => root.attrs.set(k, v), removeAttribute: (k: string) => root.attrs.delete(k),
    } as unknown as Element;
    const before = [...set].sort().join(" ");
    applyUiV2Skin(fake, true);
    expect(root.attrs.get("data-ui-v2")).toBe("on");
    applyUiV2Skin(fake, false);
    expect([...set].sort().join(" ")).toBe(before);
    expect(root.attrs.has("data-ui-v2")).toBe(false);
  });
  it("the chrome keeps its own font and the bar rules are scoped", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain('html[data-ui-v2="on"] :is(aside, header.sticky, [data-slot="sheet-content"][data-side="left"]) { font-family: var(--font-sans); }');
    const bar = css.slice(css.indexOf("NAVY SELECTION BAR"));
    for (const l of bar.split("\n").filter((x) => x.startsWith("[data-testid"))) throw new Error(`unscoped: ${l}`);
  });
  it("every skin rule is scoped to the attribute", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const block = css.slice(css.indexOf("UI V2 SKIN."), css.indexOf("NAVY SELECTION BAR"));
    const selectors = block.split("\n").filter((l) => /^(html|@media)/.test(l));
    expect(selectors.length).toBeGreaterThan(20);
    for (const l of selectors) if (l.startsWith("html")) expect(l).toContain('html[data-ui-v2="on"]');
  });
});
