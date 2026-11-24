/** Numbers route rollout. The fixture supplies a company, role and initial Numbers view state. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  company: "alpha",
  admin: true,
  localOnly: false,
  loaded: true,
  markers: ["ui-numbers-v2:on"],
}));

vi.mock("@/lib/use-user", () => ({
  useUser: () => ({ profile: { organization_id: state.company }, user: { id: "user" } }),
}));
vi.mock("@/lib/org-settings", () => ({
  useOrgSettings: () => state,
  useConfirmedCompanyNavigation: () => ({ organizationId: "alpha", userId: "user", hiddenNav: state.markers }),
}));
vi.mock("@/lib/use-numbers-view", () => ({
  MONTH_CHOICES: [3, 6, 12],
  useNumbersView: () => ({ admin: state.admin, months: 6, view: null }),
}));

import NumbersPage from "@/app/(dashboard)/numbers/page";

const render = () => renderToStaticMarkup(createElement(NumbersPage));

beforeEach(() => {
  Object.assign(state, { company: "alpha", admin: true, localOnly: false, loaded: true, markers: ["ui-numbers-v2:on"] });
});

it("renders the old Numbers when the marker is absent", () => {
  state.markers = [];
  expect(render()).toContain('data-testid="numbers-page"');
});

it("renders the new Numbers with a confirmed marker", () => {
  expect(render()).toContain('data-testid="numbers-v2"');
});

it("does not share an enabled marker between companies", () => {
  expect(render()).toContain('data-testid="numbers-v2"');
  state.company = "beta";
  expect(render()).toContain('data-testid="numbers-page"');
});

it("falls back to legacy while loading or on failure", () => {
  state.loaded = false;
  expect(render()).toContain('data-testid="numbers-page"');
  state.loaded = true;
  state.localOnly = true;
  expect(render()).toContain('data-testid="numbers-page"');
});

it("preserves the admin-only gate", () => {
  state.admin = false;
  expect(render()).not.toContain('data-testid="numbers-v2"');
});
