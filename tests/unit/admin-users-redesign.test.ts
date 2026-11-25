/** User Management route selection using a fixture identity and confirmed settings. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const feature: string[] = [];
  return {
    company: "alpha",
    loaded: true,
    localOnly: false,
    hiddenColumns: {},
    feature,
    hiddenNav: [...feature, "ui-admin-users-v2:on"],
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/admin/users",
}));
vi.mock("@/lib/use-user", () => {
  const useUser = () => ({
    user: { id: "user" },
    profile: { id: "user", role: "admin", organization_id: state.company },
    activeRole: "admin",
    hiddenSections: [],
    loading: false,
    hasRole: (role: string) => role === "admin",
    hasAnyRole: (roles: string[]) => roles.includes("admin"),
  });
  return { useUser, useMaybeUser: useUser };
});
vi.mock("@/lib/org-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/org-settings")>(),
  useOrgSettings: () => state,
  useConfirmedCompanyNavigation: () => ({ organizationId: "alpha", userId: "user", hiddenNav: state.hiddenNav }),
}));

import Screen from "@/app/(dashboard)/admin/users/page";

const render = () => renderToStaticMarkup(createElement(Screen));
const marker = 'data-testid="admin-users-v2"';

beforeEach(() => {
  Object.assign(state, { company: "alpha", loaded: true, localOnly: false, hiddenNav: [...state.feature, "ui-admin-users-v2:on"] });
});

it("renders the legacy route when the redesign marker is absent", () => {
  state.hiddenNav = state.feature;
  const page = render();
  expect(page).toContain("page-title");
  expect(page).not.toContain(marker);
});

it("renders the new view for a confirmed company marker", () => {
  expect(render()).toContain(marker);
});

it("keeps the marker isolated when the same user works in another company", () => {
  expect(render()).toContain(marker);
  state.company = "beta";
  expect(render()).not.toContain(marker);
});

it("falls back while settings are pending or failed", () => {
  state.loaded = false;
  expect(render()).not.toContain(marker);
  state.loaded = true;
  state.localOnly = true;
  expect(render()).not.toContain(marker);
});
