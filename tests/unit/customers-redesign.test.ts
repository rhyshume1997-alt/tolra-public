/** Customers view selection for an active company and role, rendering the live route. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  company: "alpha",
  role: "admin",
  localOnly: false,
  loaded: true,
  hiddenNav: ["ui-customers-v2:on"],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/use-user", () => ({
  useUser: () => ({ profile: { organization_id: state.company }, user: { id: "user" }, activeRole: state.role, loading: false, hasAnyRole: (roles: string[]) => roles.includes(state.role), hasRole: (role: string) => role === state.role }),
}));
vi.mock("@/lib/org-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/org-settings")>(),
  useOrgSettings: () => state,
  useConfirmedCompanyNavigation: () => ({ organizationId: "alpha", userId: "user", hiddenNav: state.hiddenNav }),
}));

import Screen from "@/app/(dashboard)/customers/page";

const render = () => renderToStaticMarkup(createElement(Screen));

beforeEach(() => {
  Object.assign(state, { company: "alpha", role: "admin", localOnly: false, loaded: true, hiddenNav: ["ui-customers-v2:on"] });
});

it("renders the legacy page when the marker is absent", () => {
  state.hiddenNav = [];
  expect(render()).toContain('<h1 class="page-title">Customers</h1>');
});

it("renders the new view when the marker is confirmed", () => {
  expect(render()).toContain('data-testid="customers-v2"');
});

it("isolates enabled markers between companies", () => {
  expect(render()).toContain('data-testid="customers-v2"');
  state.company = "beta";
  expect(render()).toContain('<h1 class="page-title">Customers</h1>');
});

it("falls back while settings are pending or failed", () => {
  state.loaded = false;
  expect(render()).toContain('<h1 class="page-title">Customers</h1>');
  state.loaded = true;
  state.localOnly = true;
  expect(render()).toContain('<h1 class="page-title">Customers</h1>');
});

it("retains the role gate when enabled", () => {
  state.role = "workshop";
  expect(render()).toContain("Access Denied");
  expect(render()).not.toContain('data-testid="customers-v2"');
});
