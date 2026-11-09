// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseApprovalCard, type ChaseApprovalCardProps } from "@/components/chase/approval-card";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function mount(patch: Partial<ChaseApprovalCardProps> = {}) {
  const props = {
    draft: { id: "draft-1", customerId: "customer-2", customerName: "JNR", invoiceNumber: "INV-10", to: "accounts@example.test", subject: "Invoice due", body: "Please check your invoice.\nThank you." },
    onEdit: vi.fn(), onApproveAndSend: vi.fn(), onSkip: vi.fn(), onPauseCustomer: vi.fn(), ...patch,
  };
  act(() => root.render(createElement(ChaseApprovalCard, props)));
  return props;
}
function button(text: string) { return [...host.querySelectorAll("button")].find((item) => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
function change(selector: string, value: string) {
  const field = host.querySelector(selector) as HTMLInputElement;
  act(() => {
    const proto = selector === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("chase draft approval card", () => {
  it("shows the recipient, invoice and escaped draft for review", () => {
    const props = mount();
    expect(host.textContent).toContain("INV-10");
    expect(host.textContent).toContain(props.draft.to);
    expect(host.textContent).toContain("This is a draft.");
    expect(host.textContent).toContain(props.draft.body);
    expect(button("Approve and send").disabled).toBe(false);
  });
  it("saves edits through the callback before allowing approval", async () => {
    const props = mount(); await click("Edit");
    change("input", "New subject"); change("textarea", "New message");
    expect(button("Approve and send").disabled).toBe(true);
    await click("Save draft");
    expect(props.onEdit).toHaveBeenCalledWith("draft-1", { subject: "New subject", body: "New message" });
    expect(props.onApproveAndSend).not.toHaveBeenCalled();
    expect(host.textContent).toContain("New message");
    await click("Approve and send"); expect(props.onApproveAndSend).toHaveBeenCalledWith("draft-1", { to: props.draft.to, subject: "New subject", body: "New message" });
  });
  it("cancels edits without saving or sending", async () => {
    const props = mount(); await click("Edit"); change("input", "Throw away"); await click("Cancel edit");
    expect(host.textContent).toContain("Invoice due"); expect(host.textContent).not.toContain("Throw away");
    expect(props.onEdit).not.toHaveBeenCalled(); expect(props.onApproveAndSend).not.toHaveBeenCalled();
  });
  it("requires a subject and message", async () => {
    const props = mount(); await click("Edit"); change("textarea", " "); await click("Save draft");
    expect(props.onEdit).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  it.each([
    ["Approve and send", "onApproveAndSend", "draft-1"],
    ["Skip", "onSkip", "draft-1"],
    ["Pause chasing for this customer", "onPauseCustomer", "customer-2"],
  ] as const)("%s calls only its callback and prevents a repeat", async (label, callback, id) => {
    const props = mount(); await click(label); await click(label);
    expect(props[callback]).toHaveBeenCalledTimes(1); if (callback === "onApproveAndSend") expect(props[callback]).toHaveBeenCalledWith(id, { to: props.draft.to, subject: props.draft.subject, body: props.draft.body });
    else expect(props[callback]).toHaveBeenCalledWith(id);
    for (const other of ["onApproveAndSend", "onSkip", "onPauseCustomer", "onEdit"] as const) {
      if (other !== callback) expect(props[other]).not.toHaveBeenCalled();
    }
  });
  it("locks all actions while waiting and offers retry on failure", async () => {
    let fail!: () => void;
    const props = mount({ onApproveAndSend: vi.fn(() => new Promise<void>((_, reject) => { fail = () => reject(new Error("secret")); })) });
    await click("Approve and send");
    expect([...host.querySelectorAll("button")].every((item) => item.disabled)).toBe(true);
    await act(async () => fail());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Please try again");
    expect(button("Approve and send").disabled).toBe(false);
    expect(props.onSkip).not.toHaveBeenCalled();
  });
  it("leaves failed edits open and does not allow sending them", async () => {
    mount({ onEdit: vi.fn().mockRejectedValue(new Error("failed")) });
    await click("Edit"); change("textarea", "Keep this edit"); await click("Save draft");
    expect(host.querySelector("textarea")!.value).toBe("Keep this edit");
    expect(button("Approve and send").disabled).toBe(true);
  });
  it("disables actions when the parent denies changes", () => {
    mount({ disabled: true }); expect([...host.querySelectorAll("button")].every((item) => item.disabled)).toBe(true);
  });
});
