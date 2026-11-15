/** Settings banner presentation only: real page JSX with store state supplied; no child cards, Auth or database calls run. */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrgSettings } from "@/lib/org-settings";

const h = vi.hoisted(() => ({ settings: {} as OrgSettings }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ profile: { organization_id: "company-a" } }) }));
vi.mock("@/lib/org-settings", async (original) => ({
  ...await original<typeof import("@/lib/org-settings")>(),
  useOrgSettings: () => h.settings,
}));

import SettingsPage from "@/app/(dashboard)/settings/page";

function findBanner(node: ReactNode): ReactElement | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; "data-testid"?: string }>(child)) continue;
    if (child.props["data-testid"] === "settings-unavailable") return child;
    const nested = findBanner(child.props.children);
    if (nested) return nested;
  }
  return null;
}

function banner(availability: OrgSettings["availability"], loaded: boolean, localOnly: boolean) {
  h.settings = { availability, loaded, localOnly, hiddenNav: [], hiddenColumns: {}, deviceColumns: {} };
  const element = findBanner(SettingsPage());
  return element ? renderToStaticMarkup(element) : "";
}

describe("Settings unavailable banner", () => {
  it.each([false, true])("shows online failure without claiming settings or local changes succeeded (cached=%s)", (cached) => {
    const html = banner({ kind: "unavailable", reason: "online", message: "Company settings are unavailable. Try again." }, false, cached);
    expect(html).toContain("Company settings aren&#x27;t available right now.");
    expect(html).toContain("Try again.");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("saved in this browser only");
    expect(html).not.toMatch(/Online|Synced/);
  });

  it("preserves genuine cached offline wording", () => {
    expect(banner({ kind: "offline" }, true, true)).toContain("Menu and column choices are saved in this browser only.");
  });

  it("explains missing offline cache without claiming local settings exist", () => {
    const html = banner({ kind: "unavailable", reason: "offline-cache-missing", message: "Connect to load this company's settings, then try again." }, false, false);
    expect(html).toContain("Connect to load");
    expect(html).not.toContain("saved in this browser only");
  });

  it("removes the failure banner after verified recovery and shows none while initially loading", () => {
    expect(banner({ kind: "loading" }, false, false)).toBe("");
    expect(banner({ kind: "unavailable", reason: "online", message: "Try again." }, false, false)).not.toBe("");
    expect(banner({ kind: "verified" }, true, false)).toBe("");
  });
});
