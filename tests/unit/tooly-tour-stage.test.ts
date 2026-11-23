// @vitest-environment jsdom
/**
 * The game-style tour look (components/tooly/tour/tour-stage.tsx, tour-poses.ts and the game marker in tour-switch.ts). Proves: the marker
 * is off by default and has its own text; each step gets the right pose; the dim layer covers the screen; the spotlight is placed around
 * the measured box and ignores the mouse; the bubble moves to the top when the target is low on the screen; Back, Next, Skip and the note
 * work; keys move on and skip; and the files contain no click, fetch or AI call.
 * Must not change: this file proves; the look itself is in tour-stage.tsx.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { poseForStep } from "@/components/tooly/tour/tour-poses";
import { bubbleAtTop, TourStage, type TourStageProps } from "@/components/tooly/tour/tour-stage";
import { TOOLY_GAME_TOUR_ON_MARKER, toolyGameTourOn, toolyGameTourSwitchChange } from "@/components/tooly/tour/tour-switch";

const ROOT = path.resolve(__dirname, "../..");

describe("the game marker", () => {
  it("is off unless its own marker is present, and has a fixed text", () => {
    expect(TOOLY_GAME_TOUR_ON_MARKER).toBe("tooly-game-tour:on");
    expect(toolyGameTourOn(undefined)).toBe(false);
    expect(toolyGameTourOn([])).toBe(false);
    expect(toolyGameTourOn(["tooly-admin-tour:on", "tooly-office-tour:on", "tooly-workshop-tour:on"])).toBe(false);
    expect(toolyGameTourOn([TOOLY_GAME_TOUR_ON_MARKER])).toBe(true);
    expect(toolyGameTourSwitchChange(true)).toEqual({ add: [TOOLY_GAME_TOUR_ON_MARKER], remove: [] });
    expect(toolyGameTourSwitchChange(false)).toEqual({ add: [], remove: [TOOLY_GAME_TOUR_ON_MARKER] });
  });
});

describe("poses", () => {
  it("waves on hello, celebrates on done, points at a target, thinks when there is none", () => {
    expect(poseForStep("hello", true)).toBe("wave");
    expect(poseForStep("done", true)).toBe("celebrate");
    expect(poseForStep("quotes", true)).toBe("point");
    expect(poseForStep("send-quote", false)).toBe("think");
  });
});

describe("bubble position", () => {
  it("goes to the top when the target is in the lower half, else the bottom", () => {
    expect(bubbleAtTop(null, 800)).toBe(false);
    expect(bubbleAtTop({ top: 100, left: 0, width: 50, height: 50 }, 800)).toBe(false);
    expect(bubbleAtTop({ top: 600, left: 0, width: 50, height: 50 }, 800)).toBe(true);
  });
});

let host: HTMLDivElement;
let root: Root;
const calls = { back: vi.fn(), next: vi.fn(), skip: vi.fn(), note: vi.fn() };
const base: TourStageProps = {
  number: 2, of: 5, text: "Look here.", pose: "point", box: { top: 100, left: 40, width: 200, height: 50 }, phone: false,
  note: { happens: "It happens.", produced: "It is produced." }, noteOpen: false, canBack: true, last: false,
  onToggleNote: () => calls.note(), onBack: () => calls.back(), onNext: () => calls.next(), onSkip: () => calls.skip(),
};
const show = async (over: Partial<TourStageProps> = {}) => { await act(async () => { root.render(createElement(TourStage, { ...base, ...over })); }); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (id: string) => { await act(async () => { q(id)!.click(); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.values(calls).forEach((f) => f.mockReset());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("the stage", () => {
  it("covers the whole screen, above dialogs, and puts a spotlight (not a click target) around the box", async () => {
    await show();
    expect(q("tooly-tour")!.className).toMatch(/fixed inset-0 z-\[60\]/);
    const spot = q("tooly-tour-spotlight")!;
    expect(spot.className).toMatch(/pointer-events-none/);
    expect(spot.className).toMatch(/9999px/);
    expect(spot.style.top).toBe("92px");
    expect(spot.style.left).toBe("32px");
    expect(spot.style.width).toBe("216px");
    expect(spot.style.height).toBe("66px");
    expect(q("tooly-tour-dim")).toBeNull();
  });
  it("dims the whole screen when there is nothing to point at", async () => {
    await show({ box: null, pose: "think" });
    expect(q("tooly-tour-spotlight")).toBeNull();
    expect(q("tooly-tour-dim")).not.toBeNull();
    expect(host.querySelector('[data-testid="tooly-face"]')?.getAttribute("data-pose")).toBe("think");
  });
  it("shows the step, the count and Tooly's pose", async () => {
    await show();
    expect(q("tooly-tour-count")!.textContent).toBe("Step 2 of 5");
    expect(q("tooly-tour-text")!.textContent).toBe("Look here.");
    expect(host.querySelector('[data-testid="tooly-face"]')?.getAttribute("data-pose")).toBe("point");
    expect(q("tooly-tour-bubble")!.getAttribute("role")).toBe("dialog");
  });
  it("offers only the note toggle, Back, Next and Skip, and they call back", async () => {
    await show();
    expect(Array.from(host.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"))).toEqual(["tooly-tour-note-toggle", "tooly-tour-back", "tooly-tour-next", "tooly-tour-stop"]);
    await press("tooly-tour-back");
    await press("tooly-tour-next");
    await press("tooly-tour-stop");
    await press("tooly-tour-note-toggle");
    expect([calls.back, calls.next, calls.skip, calls.note].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });
  it("says Finish on the last step, disables Back on the first, and shows the note when open", async () => {
    await show({ last: true, canBack: false, noteOpen: true });
    expect(q("tooly-tour-next")!.textContent).toBe("Finish");
    expect((q("tooly-tour-back") as HTMLButtonElement).disabled).toBe(true);
    expect(q("tooly-tour-note")!.textContent).toContain("It is produced.");
  });
  it("puts the bubble at the top for a low target and the bottom for a high one", async () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    await show({ box: { top: 650, left: 0, width: 100, height: 40 } });
    expect(q("tooly-tour-bubble")!.getAttribute("data-position")).toBe("top");
    await show({ box: { top: 50, left: 0, width: 100, height: 40 } });
    expect(q("tooly-tour-bubble")!.getAttribute("data-position")).toBe("bottom");
  });
  it("moves with the arrow keys and skips with Escape", async () => {
    await show();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" })); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect([calls.next, calls.back, calls.skip].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
  it("has no click, fetch or AI call in the new files", () => {
    for (const file of ["components/tooly/tour/tour-stage.tsx", "components/tooly/tour/tour-poses.ts"]) {
      const src = readFileSync(path.join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, file).not.toMatch(/\.click\(|dispatchEvent|requestSubmit|fetch\(|supabase|openai|anthropic/i);
    }
  });
});
