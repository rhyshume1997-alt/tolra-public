// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { SetupCard } from "@/components/integrations/setup-card";

async function render(props: Parameters<typeof SetupCard>[0]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(createElement(SetupCard, props)));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const base = { id: "x", title: "Demo", summary: "One sentence.", connection: { tone: "ok" as const, label: "Signed in as a@b.invalid" }, steps: [{ label: "Connect", state: "done" as const }, { label: "Map", state: "next" as const }, { label: "Switch on", state: "later" as const }] };

describe("SetupCard (the one frame for the four Integrations cards)", () => {
  it("connected is not on: the activation switch is separate and shows Off by default", async () => {
    const { host, done } = await render({ ...base, activation: { label: "Turn on transfers", on: false, onChange: vi.fn() } });
    expect(host.querySelector('[data-testid="connection-x"]')?.textContent).toContain("Signed in");
    const sw = host.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[data-testid="activation-badge-x"]')?.textContent).toBe("transfers: Off");
    await done();
  });
  it("an unknown state is shown as Unknown, never as on", async () => {
    const { host, done } = await render({ ...base, activation: { label: "Turn on AI", on: null, onChange: vi.fn() } });
    expect(host.querySelector('[data-testid="activation-badge-x"]')?.textContent).toBe("AI: Unknown");
    expect((host.querySelector('[role="switch"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    await done();
  });
  it("a disabled reason disables the switch, shows the reason, and a click changes nothing", async () => {
    const onChange = vi.fn();
    const { host, done } = await render({ ...base, activation: { label: "Turn on AI", on: false, onChange, disabledReason: "The server has AI switched off." } });
    const sw = host.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(host.querySelector('[data-testid="activation-why-x"]')?.textContent).toBe("The server has AI switched off.");
    await act(async () => sw.click());
    expect(onChange).not.toHaveBeenCalled();
    await done();
  });
  it("an enabled switch asks for the opposite of the current state", async () => {
    const onChange = vi.fn();
    const { host, done } = await render({ ...base, activation: { label: "Turn on AI", on: false, onChange } });
    await act(async () => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith(true);
    await done();
  });
  it("lists the steps in order with done / next / later", async () => {
    const { host, done } = await render({ ...base, activation: { label: "Turn on AI", on: false } });
    expect([...host.querySelectorAll("li")].map((li) => li.getAttribute("data-state"))).toEqual(["done", "next", "later"]);
    await done();
  });
});
