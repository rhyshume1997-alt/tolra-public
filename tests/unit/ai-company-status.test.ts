// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
const identity = vi.hoisted(() => ({ organization_id: "company-a", id: "admin" }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ profile: identity, activeRole: "admin" }) }));
vi.mock("@/components/ai-features", () => ({ useAiFeatures: () => ({ aiHelper: true }) }));
afterEach(() => vi.unstubAllGlobals());
it("clears the previous company on switch and ignores its late response", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pending: Array<(value: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    const { status } = useAiHelperStatus();
    return createElement("span", null, status ? String(status.roundup_enabled) : "loading");
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    identity.organization_id = "company-b";
    await act(async () => root.render(createElement(Probe)));
    expect(pending).toHaveLength(2);
    expect(container.textContent).toBe("loading");
    await act(async () => pending[1](Response.json({ roundup_enabled: false })));
    expect(container.textContent).toBe("false");
    await act(async () => pending[0](Response.json({ roundup_enabled: true })));
    expect(container.textContent).toBe("false");
  } finally { await act(async () => root.unmount()); }
});
