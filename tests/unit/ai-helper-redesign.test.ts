/** AI route coverage using a simulated session/settings response and the real live panels. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  company: "alpha",
  role: "admin",
  localOnly: false,
  loaded: true,
  navigation: null as null | { organizationId: string; userId: string; hiddenNav: string[] },
  status: { can_manage: true, roundup_enabled: true, rfq_enabled: true, assistant_available: true, assistant_enabled: true },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/use-user", () => ({
  useUser: () => ({
    user: { id: "user-1" },
    profile: { organization_id: state.company },
    activeRole: state.role,
    loading: false,
  }),
}));
vi.mock("@/lib/org-settings", () => ({
  useOrgSettings: () => ({ loaded: state.loaded, localOnly: state.localOnly }),
  useConfirmedCompanyNavigation: () => state.navigation,
}));
vi.mock("@/components/ai-helper/use-ai-helper-status", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/ai-helper/use-ai-helper-status")>(),
  useAiHelperStatus: () => ({ status: state.status, loaded: true, allowed: true, reload: vi.fn() }),
}));

import AiHelperPage from "@/app/(dashboard)/ai-helper/page";

const render = () => renderToStaticMarkup(createElement(AiHelperPage));

beforeEach(() => {
  Object.assign(state, {
    company: "alpha",
    role: "admin",
    localOnly: false,
    loaded: true,
    navigation: { organizationId: "alpha", userId: "user-1", hiddenNav: ["ui-ai-v2:on"] },
  });
});

describe("AI redesign", () => {
  it("renders the existing page when the marker is absent", () => {
    state.navigation!.hiddenNav = [];
    const page = render();
    expect(page).toContain('<h1 class="page-title">AI</h1>');
    expect(page).not.toContain('data-testid="ai-helper-v2"');
  });

  it("renders the new screen with the three live panels when enabled", () => {
    const page = render();
    expect(page).toContain('data-testid="ai-helper-v2"');
    for (const panel of ["roundup", "rfq", "assistant"]) expect(page).toContain(`data-testid="ai-${panel}-panel"`);
  });

  it("does not carry the new screen over to the user's other company", () => {
    expect(render()).toContain('data-testid="ai-helper-v2"');
    state.company = "beta";
    expect(render()).toContain('<h1 class="page-title">AI</h1>');
  });

  it("selects the legacy page for pending or failed settings", () => {
    state.loaded = false;
    expect(render()).not.toContain('data-testid="ai-helper-v2"');
    state.loaded = true;
    state.localOnly = true;
    expect(render()).not.toContain('data-testid="ai-helper-v2"');
  });

  it("keeps the role gate for the new screen", () => {
    state.role = "workshop";
    const page = render();
    expect(page).toContain("Access Denied");
    expect(page).not.toContain('data-testid="ai-helper-v2"');
  });
});
