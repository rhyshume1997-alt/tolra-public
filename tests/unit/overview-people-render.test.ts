/**
 * The Overview's People heading, rendered (react-dom/server): "N on the floor now" from the clock records, and a dash with the reason,
 * never 0, when those records couldn't be read (lib/overview floorNow, lib/floor-attendance loadClockedIn).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OverviewSection } from "@/components/overview";
import { loadClockedIn } from "@/lib/floor-attendance";
import { floorNow } from "@/lib/overview";

// The section only asks whether its link opens for this person; the sign-in context is not what is under test.
vi.mock("@/lib/use-destinations", () => ({ useCanOpen: () => () => true }));

const people = (figure: string) => {
  const props = { id: "people", title: "People", figure, sub: "This week", children: null };
  return renderToStaticMarkup(createElement(OverviewSection, props));
};
const figureText = (html: string) => /data-testid="overview-people-figure">([^<]*)</.exec(html)?.[1]?.replaceAll("&#x27;", "'");

describe("Overview People: on the floor now", () => {
  it("shows the number clocked in", () => {
    expect(figureText(people(floorNow({ clockedIn: 3 }, false).figure))).toBe("3 on the floor now");
  });

  it("a read that failed shows a dash and the reason, not 0", async () => {
    const failing = { from: () => { throw new Error("offline"); } } as never;
    const clocked = await loadClockedIn(failing);
    expect(clocked).toBeNull();
    const html = people(floorNow(clocked, false).figure);
    expect(figureText(html)).toBe("— Couldn't load this.");
    expect(html).not.toMatch(/\b0 on the floor/);
  });

  it("a read that is still loading shows a dash too", () => {
    expect(figureText(people(floorNow(null, true).figure))).toBe("— Loading…");
  });
});
