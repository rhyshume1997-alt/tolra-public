// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseSettingsCard, type ChaseStep } from "@/components/chase/settings-card";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const steps: ChaseStep[] = [{ days: -3, tone: "before_due" }, { days: 7, tone: "friendly" }];
function mount(onSave = vi.fn(), disabled = false, initialSteps = steps) {
  act(() => root.render(createElement(ChaseSettingsCard, { initialSteps, onSave, disabled })));
  return onSave;
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text)!;
  await act(async () => button.click());
}
async function submit() {
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
function input(value: string) {
  const field = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("payment chasing settings", () => {
  it("shows the approval note, negative days and plain tone labels", () => {
    mount();
    expect(host.textContent).toContain("Chasers are drafts for approval.");
    expect(host.querySelector("input")!.value).toBe("-3");
    expect([...host.querySelectorAll("option")].slice(0, 4).map((o) => o.value)).toEqual(["before_due", "friendly", "firm", "final"]);
    expect(host.textContent).toContain("negative number");
  });
  it("edits days and tone, adds and removes rows, and saves only through the callback", async () => {
    const onSave = mount();
    input("-5");
    const tone = host.querySelector("select")!;
    act(() => { tone.value = "firm"; tone.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("Add step");
    await act(async () => (host.querySelector('[aria-label="Remove step 2"]') as HTMLButtonElement).click());
    await submit();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith([{ days: -5, tone: "firm" }, { days: 7, tone: "friendly" }]);
    expect(steps[0]).toEqual({ days: -3, tone: "before_due" });
    expect(host.textContent).toContain("Chase steps saved.");
  });
  it("can remove all steps and save an empty schedule", async () => {
    const onSave = mount(vi.fn(), false, []);
    expect(host.textContent).toContain("No chase steps.");
    expect(host.textContent).toContain("Chasers are drafts for approval.");
    await submit(); expect(onSave).toHaveBeenCalledWith([]);
  });
  it.each(["", "1.5", "9007199254740992"])("rejects invalid days %s", async (value) => {
    const onSave = mount(); input(value); await submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("whole number");
  });
  it("locks editing and repeated saves while waiting, then allows retry after failure", async () => {
    let reject!: () => void;
    const onSave = mount(vi.fn(() => new Promise<void>((_, fail) => { reject = () => fail(new Error("private failure")); })));
    await submit(); await submit();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll("button, input, select")].every((e) => (e as HTMLButtonElement).disabled)).toBe(true);
    expect(host.textContent).toContain("Chasers are drafts for approval.");
    await act(async () => reject());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Please try again.");
    expect(host.textContent).not.toContain("private failure");
    expect(host.querySelector("input")!.disabled).toBe(false);
  });
  it("does not save when disabled", async () => {
    const onSave = mount(vi.fn(), true); await submit(); expect(onSave).not.toHaveBeenCalled();
  });
});
