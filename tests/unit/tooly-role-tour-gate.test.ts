// @vitest-environment jsdom
/**
 * The tour card (components/tooly/tour/admin-tour.tsx) for the three views. Proves, with the real card and faked sign-in, company settings,
 * route and done flag: the tour shows by default and nothing shows only when the server's emergency switch is off (company markers are not read); admin, office and workshop each
 * get their own first step and step count; a viewer and a person who has already finished see nothing; the card only offers Back, Next, the note
 * toggle and Skip tour; the note opens on request; a person who has seen it can replay from Account Settings on any page (tour-replay.ts); and it never presses anything on the page behind it (a button on the page is not clicked while the tour moves through its steps).
 * Must not change: this file proves; the plan and switch rules are proved in tooly-role-tours.test.ts and tooly-tour.test.ts.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  role: "office" as string | null,
  hiddenNav: [] as string[],
  done: false,
  path: "/dashboard",
};
const push = vi.fn();
const markDone = vi.fn();

vi.mock("next/navigation", () => ({ usePathname: () => state.path, useRouter: () => ({ push }) }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ user: { id: "u1", user_metadata: {} }, activeRole: state.role, hiddenSections: [] as string[] }) }));
vi.mock("@/lib/org-settings", () => ({ useOrgSettings: () => ({ hiddenNav: state.hiddenNav }) }));
vi.mock("@/lib/view-mode", () => ({ useIsWide: () => true }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/auth/tour-flag", () => ({ isTourDone: () => state.done, markTourDone: (...args: unknown[]) => markDone(...args) }));

import { requestTourReplay, tourReplayAvailable } from "@/components/tooly/tour/tour-replay";
import { AdminTour } from "@/components/tooly/tour/admin-tour";
import { TOOLY_GAME_TOUR_ON_MARKER, TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_TOUR_ON_MARKER, TOOLY_WORKSHOP_TOUR_ON_MARKER } from "@/components/tooly/tour/tour-switch";

let host: HTMLDivElement;
let root: Root;
let pressed: number;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(state, { role: "office", hiddenNav: [], done: false, path: "/dashboard" });
  push.mockReset();
  markDone.mockReset();
  pressed = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // A button that belongs to the app, behind the tour: the tour must never press it.
  const behind = document.createElement("button");
  behind.textContent = "New quote";
  behind.addEventListener("click", () => { pressed += 1; });
  document.body.append(behind);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll("button").forEach((b) => { if (b.textContent === "New quote") b.remove(); });
});

async function show(envOn: boolean) {
  await act(async () => { root.render(createElement(AdminTour, { envOn })); });
}
const card = () => host.querySelector('[data-testid="tooly-tour"]');
const count = () => host.querySelector('[data-testid="tooly-tour-count"]')?.textContent ?? "";
const text = () => host.querySelector('[data-testid="tooly-tour-text"]')?.textContent ?? "";
const press = async (id: string) => { await act(async () => { (host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click(); }); };

describe("who sees which tour", () => {
  it("shows with no company marker at all, and nothing shows when the server's emergency switch has turned it off", async () => {
    state.hiddenNav = [];
    await show(true);
    expect(card()).not.toBeNull();
    await show(false);
    expect(card()).toBeNull();
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    await show(false);
    expect(card()).toBeNull();
  });
  it("office gets the 17 office steps from Tooly's hello, with its own marker", async () => {
    state.role = "office";
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    await show(true);
    expect(count()).toBe("Step 1 of 17");
    expect(text()).toMatch(/pages you use as office staff/);
  });
  it("workshop gets the 13 workshop steps with its own marker", async () => {
    state.role = "workshop";
    state.hiddenNav = [TOOLY_WORKSHOP_TOUR_ON_MARKER];
    await show(true);
    expect(count()).toBe("Step 1 of 13");
    expect(text()).toMatch(/parts of the app you use in the workshop/);
  });
  it("admin still gets the 23 admin steps with the admin marker", async () => {
    state.role = "admin";
    state.hiddenNav = [TOOLY_TOUR_ON_MARKER];
    await show(true);
    expect(count()).toBe("Step 1 of 23");
  });
  it("each view gets its own tour whatever markers the company has", async () => {
    for (const [role, marker, steps] of [["office", TOOLY_TOUR_ON_MARKER, 17], ["workshop", TOOLY_TOUR_ON_MARKER, 13], ["admin", TOOLY_OFFICE_TOUR_ON_MARKER, 23], ["workshop", TOOLY_OFFICE_TOUR_ON_MARKER, 13]] as const) {
      state.role = role;
      state.hiddenNav = [marker];
      await show(true);
      expect(count(), `${role} with ${marker}`).toBe(`Step 1 of ${steps}`);
    }
  });
  it("a viewer sees nothing even with every marker on", async () => {
    state.role = "viewer";
    state.hiddenNav = [TOOLY_TOUR_ON_MARKER, TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_WORKSHOP_TOUR_ON_MARKER];
    await show(true);
    expect(card()).toBeNull();
  });
  it("a person who has already finished it sees nothing", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    state.done = true;
    await show(true);
    expect(card()).toBeNull();
  });
});

describe("seen once, then replay", () => {
  it("a person who has seen it can replay from any page; no hidden button exists; replay starts at step 1", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    state.done = true;
    for (const path of ["/dashboard", "/jobs", "/settings"]) {
      state.path = path;
      await show(true);
      expect(card(), path).toBeNull();
      expect(host.querySelector('[data-testid="tooly-tour-replay"]')).toBeNull();
      expect(tourReplayAvailable(), path).toBe(true);
    }
    state.path = "/jobs";
    await show(true);
    await act(async () => { expect(requestTourReplay()).toBe(true); });
    expect(count()).toBe("Step 1 of 17");
    await press("tooly-tour-next");
    await press("tooly-tour-stop");
    expect(card()).toBeNull();
    expect(markDone).toHaveBeenCalledTimes(1);
  });
  it("no replay with the switches off or for a viewer, and nothing happens when asked", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    state.done = true;
    await show(false);
    expect(tourReplayAvailable()).toBe(false);
    expect(requestTourReplay()).toBe(false);
    expect(card()).toBeNull();
    state.role = "viewer";
    await show(true);
    expect(tourReplayAvailable()).toBe(false);
  });
  it("opens by itself for a person who has not seen it, without a Replay button", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    await show(true);
    expect(card()).not.toBeNull();
    expect(tourReplayAvailable()).toBe(false);
  });
  it("the sidebar has no hidden-button click path and the replay is offered in Account Settings only", async () => {
    const { readFileSync } = await import("node:fs");
    const side = readFileSync("components/sidebar.tsx", "utf8");
    expect(side).not.toMatch(/tooly-tour-replay|querySelector/);
    expect(side).toMatch(/requestTourReplay\(\)/);
    expect(side.match(/>Replay tour</g)?.length).toBe(1);
    expect(readFileSync("components/tooly/tour/admin-tour.tsx", "utf8")).not.toMatch(/data-testid="tooly-tour-replay"/);
  });
});

describe("walking through it", () => {
  it("offers only Back, Next, the note toggle and Skip tour, moves one step at a time, and goes to the step's page by navigation", async () => {
    state.role = "workshop";
    state.hiddenNav = [TOOLY_WORKSHOP_TOUR_ON_MARKER];
    await show(true);
    expect(Array.from(host.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"))).toEqual(["tooly-tour-note-toggle", "tooly-tour-back", "tooly-tour-next", "tooly-tour-stop"]);
    expect((host.querySelector('[data-testid="tooly-tour-back"]') as HTMLButtonElement).disabled).toBe(true);
    await press("tooly-tour-next");
    expect(count()).toBe("Step 2 of 13");
    await press("tooly-tour-back");
    expect(count()).toBe("Step 1 of 13");
    // Step 4 is the Job Board: the tour is on /dashboard, so it moves there by navigation.
    for (let i = 0; i < 3; i += 1) await press("tooly-tour-next");
    expect(count()).toBe("Step 4 of 13");
    expect(push).toHaveBeenCalledWith("/jobs");
  });
  it("Skip tour saves the done flag once and closes the card", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    await show(true);
    await press("tooly-tour-stop");
    expect(markDone).toHaveBeenCalledTimes(1);
    expect(markDone.mock.calls[0][1]).toBe("u1");
    expect(card()).toBeNull();
  });
  it("each step has a note that is closed until asked for, and closes again on the next step", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    await show(true);
    expect(host.querySelector('[data-testid="tooly-tour-note"]')).toBeNull();
    await press("tooly-tour-note-toggle");
    expect(host.querySelector('[data-testid="tooly-tour-note"]')?.textContent).toContain("How it gets produced");
    expect(host.querySelector('[data-testid="tooly-tour-note-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    await press("tooly-tour-next");
    expect(host.querySelector('[data-testid="tooly-tour-note"]')).toBeNull();
    expect(markDone).not.toHaveBeenCalled();
  });
  it("the last step says Finish and saves the done flag", async () => {
    state.role = "workshop";
    state.hiddenNav = [TOOLY_WORKSHOP_TOUR_ON_MARKER];
    await show(true);
    for (let i = 0; i < 12; i += 1) await press("tooly-tour-next");
    expect(count()).toBe("Step 13 of 13");
    expect(host.querySelector('[data-testid="tooly-tour-next"]')?.textContent).toBe("Finish");
    await press("tooly-tour-next");
    expect(markDone).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
  });
  it("never presses a button on the page behind it, from the first step to the last", async () => {
    state.role = "office";
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    await show(true);
    for (let i = 0; i < 16; i += 1) await press("tooly-tour-next");
    expect(count()).toBe("Step 17 of 17");
    expect(pressed).toBe(0);
  });
});

describe("the game look", () => {
  it("is not used unless its own marker is on: the small card shows", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER];
    await show(true);
    expect(card()?.getAttribute("data-mode")).toBeNull();
    expect(host.querySelector('[data-testid="tooly-tour-bubble"]')).toBeNull();
  });
  it("the game marker only changes the look: with it alone the tour still shows by default (as the game look), and the emergency switch still turns it off", async () => {
    state.hiddenNav = [TOOLY_GAME_TOUR_ON_MARKER];
    await show(true);
    expect(card()).not.toBeNull();
    expect(card()?.getAttribute("data-mode")).toBe("game");
    expect(count()).toBe("Step 1 of 17");
    await show(false);
    expect(card()).toBeNull();
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_GAME_TOUR_ON_MARKER];
    await show(false);
    expect(card()).toBeNull();
  });
  it("with both markers: the full-screen stage, the same steps, notes, Skip and seen flag", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_GAME_TOUR_ON_MARKER];
    await show(true);
    expect(card()?.getAttribute("data-mode")).toBe("game");
    expect(count()).toBe("Step 1 of 17");
    expect(host.querySelector('[data-testid="tooly-face"]')?.getAttribute("data-pose")).toBe("wave");
    await press("tooly-tour-note-toggle");
    expect(host.querySelector('[data-testid="tooly-tour-note"]')).not.toBeNull();
    await press("tooly-tour-next");
    expect(count()).toBe("Step 2 of 17");
    expect(host.querySelector('[data-testid="tooly-tour-note"]')).toBeNull();
    await press("tooly-tour-stop");
    expect(markDone).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
  });
  it("never presses a button on the page behind it, first step to last", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_GAME_TOUR_ON_MARKER];
    await show(true);
    for (let i = 0; i < 16; i += 1) await press("tooly-tour-next");
    expect(count()).toBe("Step 17 of 17");
    expect(pressed).toBe(0);
  });
  it("Replay still works after it has been seen", async () => {
    state.hiddenNav = [TOOLY_OFFICE_TOUR_ON_MARKER, TOOLY_GAME_TOUR_ON_MARKER];
    state.done = true;
    await show(true);
    await act(async () => { requestTourReplay(); });
    expect(card()?.getAttribute("data-mode")).toBe("game");
    expect(count()).toBe("Step 1 of 17");
  });
});
