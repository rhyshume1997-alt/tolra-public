/** Settings notice: real page JSX and real store failure/recovery; unrelated child cards and Auth are not mounted. */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgSettings } from "@/lib/org-settings";

const h = vi.hoisted(() => ({ settings: {} as OrgSettings, realStore: false, gatewayFailure: false, orgReads: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/lib/supabase", () => ({ supabase: {
  auth: { getUser: async () => ({ data: { user: { id: "user-a" } }, error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null, status: 200 }) }) }) }),
} }));
vi.mock("@/lib/supabase-business", () => ({
  getCurrentUserAndOrganization: async () => {
    h.orgReads();
    if (h.gatewayFailure) throw { status: 502, message: "Bad Gateway" };
    return { userId: "user-a", organizationId: "company-a" };
  },
}));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ profile: { organization_id: "company-a" } }) }));
vi.mock("@/lib/org-settings", async (original) => {
  const store = await original<typeof import("@/lib/org-settings")>();
  return { ...store, useOrgSettings: () => h.realStore ? store.useOrgSettings() : h.settings };
});

import SettingsPage from "@/app/(dashboard)/settings/page";
import { getOrgSettingsSnapshot, loadOrgSettings, resetOrgSettings } from "@/lib/org-settings";
import { RoleGate } from "@/components/role-gate";

afterEach(() => { resetOrgSettings(); h.realStore = false; h.gatewayFailure = false; vi.unstubAllGlobals(); });

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
  it("an online organisation lookup 502 flows through the real store into the page notice and clears after verified recovery", async () => {
    const cache = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) } });
    vi.stubGlobal("navigator", { onLine: true });
    h.realStore = true;
    h.orgReads.mockClear();
    await loadOrgSettings(true);
    const before = SettingsPage();
    expect(before.type).toBe(RoleGate);
    expect(before.props.allowed).toEqual(["admin"]);
    expect(findBanner(before)).toBeNull();
    const cards = (node: ReturnType<typeof SettingsPage>) => Children.toArray(node.props.children.props.children)
      .filter((child) => isValidElement<{ "data-testid"?: string }>(child) && child.props["data-testid"] !== "settings-unavailable")
      .map((child) => (child as ReactElement).type);

    h.gatewayFailure = true;
    await loadOrgSettings(true);
    expect(h.orgReads).toHaveBeenCalledTimes(2);
    expect(getOrgSettingsSnapshot()).toMatchObject({ loaded: false, availability: { kind: "unavailable", reason: "online" } });
    const failed = SettingsPage();
    expect(failed.type).toBe(RoleGate);
    expect(failed.props.allowed).toEqual(["admin"]);
    expect(cards(failed)).toEqual(cards(before));
    const notice = findBanner(failed);
    expect(notice).not.toBeNull();
    const html = renderToStaticMarkup(notice!);
    expect(html).toContain("Company settings aren&#x27;t available right now.");
    expect(html).not.toContain("saved in this browser only");

    h.gatewayFailure = false;
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().availability.kind).toBe("verified");
    expect(findBanner(SettingsPage())).toBeNull();
  });

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
