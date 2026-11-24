/** Operations Reports route selection. Mocks session and read state while rendering both real Reports components. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  organizationId: "alpha",
  userId: "alex",
  hiddenNav: ["reports:on"],
  loaded: true,
  localOnly: false,
  navigation: null as null | { organizationId: string; userId: string; hiddenNav: string[] },
}));

vi.mock("@/lib/use-user", () => ({
  useUser: () => ({
    profile: { organization_id: state.organizationId },
    user: { id: state.userId },
    loading: false,
    activeRole: "admin",
    hiddenSections: [],
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/org-settings", () => ({
  useOrgSettings: () => state,
  useConfirmedCompanyNavigation: () => state.navigation,
}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/reports/use-reports-data", () => ({
  REPORT_PERIODS: [3, 6, 12],
  useReportsData: () => ({ months: 12, data: null, setMonths: vi.fn(), retry: vi.fn() }),
}));

import ReportsPage from "@/app/(dashboard)/reports/page";
import { REPORTS_UI_V2_MARKER } from "@/lib/reports/reports-switch";

const render = () => renderToStaticMarkup(createElement(ReportsPage));

beforeEach(() => {
  Object.assign(state, {
    organizationId: "alpha",
    userId: "alex",
    hiddenNav: ["reports:on"],
    loaded: true,
    localOnly: false,
    navigation: { organizationId: "alpha", userId: "alex", hiddenNav: ["reports:on", REPORTS_UI_V2_MARKER] },
  });
});

describe("Reports redesign", () => {
  it("renders the legacy view when the redesign marker is absent", () => {
    state.navigation!.hiddenNav = ["reports:on"];
    expect(render()).toContain('data-testid="reports-view"');
  });

  it("renders the new view when both switches are confirmed for this company", () => {
    expect(render()).toContain('data-testid="reports-view-v2"');
  });

  it("keeps the feature switch independent", () => {
    state.hiddenNav = [REPORTS_UI_V2_MARKER];
    state.navigation!.hiddenNav = state.hiddenNav;
    expect(render()).toContain("Reports are switched off for your company.");
  });

  it("falls back while the settings read is in flight", () => {
    state.navigation = null;
    expect(render()).toContain('data-testid="reports-view"');
    state.loaded = false;
    expect(render()).toContain('data-slot="skeleton"');
    expect(render()).not.toContain('data-testid="reports-view-v2"');
  });

  it("falls back when a failed settings read uses cached markers", () => {
    state.localOnly = true;
    state.hiddenNav.push(REPORTS_UI_V2_MARKER);
    expect(render()).toContain('data-testid="reports-view"');
  });

  it("never applies an enabled company's marker to a second company for the same user", () => {
    expect(render()).toContain('data-testid="reports-view-v2"');
    state.organizationId = "beta";
    expect(render()).toContain('data-testid="reports-view"');
    state.navigation = { organizationId: "beta", userId: "alex", hiddenNav: ["reports:on"] };
    expect(render()).toContain('data-testid="reports-view"');
    state.organizationId = "alpha";
    state.userId = "bea";
    state.navigation = { organizationId: "alpha", userId: "alex", hiddenNav: ["reports:on", REPORTS_UI_V2_MARKER] };
    expect(render()).toContain('data-testid="reports-view"');
  });
});
