import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { AiConnectionCard } from "@/components/integrations/ai-connection-card";

const state = vi.hoisted(() => ({ allowed: true, loaded: true, status: null as AiHelperStatus | null, setStatus: vi.fn() }));
vi.mock("@/components/ai-helper/use-ai-helper-status", async (original) => ({ ...(await original<object>()), useAiHelperStatus: () => state }));
const render = () => renderToStaticMarkup(createElement(AiConnectionCard));
const status = (on: boolean): AiHelperStatus => ({ roundup_enabled: on, rfq_enabled: on, monthly_cap_pence: 1200, key_set: false, key_last4: null, month_spent_pence: 0, month_reserved_pence: 0, can_manage: true });
beforeEach(() => { state.allowed = true; state.loaded = true; state.status = status(false); });
describe("AI beside accounting connections", () => {
  it("renders the existing company master switch off, then reflects the next company's on state", () => {
    expect(render()).toContain('data-testid="ai-master-switch"');
    expect(render()).toContain("AI is off");
    state.status = status(true);
    expect(render()).toContain("AI is on");
    expect(render()).toContain("Nothing runs until a monthly limit is set");
    expect(render()).toContain('href="/ai-helper"');
  });
  it("does not offer a switch during loading, unavailable server, or failed company read", () => {
    state.loaded = false;
    expect(render()).toContain("Loading AI connection");
    expect(render()).not.toContain('data-testid="ai-master-switch"');
    state.loaded = true; state.allowed = false;
    expect(render()).toContain("AI is unavailable. Ask your admin to contact Tolra support.");
    state.allowed = true; state.status = null;
    expect(render()).toContain('role="alert"');
    expect(render()).not.toContain('data-testid="ai-master-switch"');
  });
  it("keeps the master switch read-only when the server says the person cannot manage it", () => {
    state.status = { ...status(false), can_manage: false };
    expect(render()).toMatch(/data-testid="ai-master-switch"[^>]*disabled/);
  });
});
