// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerSaysPaid, type CustomerSaysPaidProps } from "@/components/chase/customer-says-paid";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function mount(patch: Partial<CustomerSaysPaidProps> = {}) {
  const props = { invoiceId: "invoice-1", invoiceNumber: "INV-12", paymentToConfirm: false,
    onCustomerSaysPaid: vi.fn(), onConfirmPaymentReceived: vi.fn(), onNotReceivedResumeChasing: vi.fn(), ...patch };
  act(() => root.render(createElement(CustomerSaysPaid, props)));
  return props;
}
function button(text: string) { return [...host.querySelectorAll("button")].find((item) => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }

describe("customer says paid invoice controls", () => {
  it("records a claim through its callback without confirming receipt", async () => {
    const props = mount(); await click("Customer says paid"); await click("Customer says paid");
    expect(props.onCustomerSaysPaid).toHaveBeenCalledTimes(1);
    expect(props.onCustomerSaysPaid).toHaveBeenCalledWith("invoice-1");
    expect(props.onConfirmPaymentReceived).not.toHaveBeenCalled();
    expect(props.onNotReceivedResumeChasing).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Payment confirmed as received.");
  });
  it("shows a clear banner and both choices only when the parent marks payment to confirm", () => {
    mount({ paymentToConfirm: true });
    expect(host.textContent).toContain("Payment to confirm");
    expect(host.textContent).toContain("INV-12");
    expect(host.textContent).toContain("Chasing is paused");
    expect(host.textContent).toContain("This does not mean the payment has been received.");
    expect(host.textContent).not.toContain("Customer says paid");
    expect(button("Confirm payment received")).toBeTruthy();
    expect(button("Not received, resume chasing")).toBeTruthy();
  });
  it.each([
    ["Confirm payment received", "onConfirmPaymentReceived", "onNotReceivedResumeChasing"],
    ["Not received, resume chasing", "onNotReceivedResumeChasing", "onConfirmPaymentReceived"],
  ] as const)("%s invokes only its callback, once", async (label, callback, other) => {
    const props = mount({ paymentToConfirm: true }); await click(label); await click(label);
    expect(props[callback]).toHaveBeenCalledTimes(1); expect(props[callback]).toHaveBeenCalledWith("invoice-1");
    expect(props[other]).not.toHaveBeenCalled(); expect(props.onCustomerSaysPaid).not.toHaveBeenCalled();
  });
  it("waits for the parent to change payment state and unlocks the next choice", async () => {
    const props = mount(); await click("Customer says paid");
    expect(button("Customer says paid").disabled).toBe(true);
    act(() => root.render(createElement(CustomerSaysPaid, { ...props, paymentToConfirm: true })));
    expect(button("Confirm payment received").disabled).toBe(false);
    await click("Not received, resume chasing");
    act(() => root.render(createElement(CustomerSaysPaid, props)));
    expect(button("Customer says paid").disabled).toBe(false);
  });
  it("unlocks the banner when the parent updates state inside the callback", async () => {
    let finish!: () => void;
    const props = mount({ onCustomerSaysPaid: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
    await click("Customer says paid");
    act(() => root.render(createElement(CustomerSaysPaid, { ...props, paymentToConfirm: true })));
    await act(async () => finish());
    expect(button("Confirm payment received").disabled).toBe(false);
  });
  it("blocks competing actions until a pending callback settles, and allows retry on failure", async () => {
    let fail!: () => void;
    const props = mount({ paymentToConfirm: true, onConfirmPaymentReceived: vi.fn(() => new Promise<void>((_, reject) => { fail = () => reject(new Error("internal")); })) });
    await click("Confirm payment received"); await click("Not received, resume chasing");
    expect(props.onNotReceivedResumeChasing).not.toHaveBeenCalled();
    expect([...host.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    await act(async () => fail());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Please try again.");
    expect(button("Confirm payment received").disabled).toBe(false);
  });
  it.each([false, true])("honours disabled for paymentToConfirm=%s", (paymentToConfirm) => {
    mount({ disabled: true, paymentToConfirm });
    expect([...host.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  });
});
