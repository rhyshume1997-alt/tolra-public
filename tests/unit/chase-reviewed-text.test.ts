// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { ChaseApprovalCard } from "@/components/chase/approval-card";

it("the approval button passes the exact displayed snapshot, including whitespace, to its sender", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onApproveAndSend = vi.fn().mockResolvedValue(undefined);
  const draft = {
    id: "draft", customerId: "customer", customerName: "Acme", invoiceNumber: "INV-1", to: "pay@example.test",
    subject: "Invoice INV-1", body: "Hello Acme,\n\n  Keep this spacing.\n",
  };
  try {
    await act(async () => root.render(createElement(ChaseApprovalCard, {
      draft, onApproveAndSend, onEdit: vi.fn(), onSkip: vi.fn(), onPauseCustomer: vi.fn(),
    })));
    expect(container.textContent).toContain(draft.subject);
    expect(container.textContent).toContain(draft.body);
    const button = Array.from(container.querySelectorAll("button")).find(node => node.textContent === "Approve and send")!;
    await act(async () => button.click());
    expect(onApproveAndSend).toHaveBeenCalledTimes(1);
    expect(onApproveAndSend).toHaveBeenCalledWith(draft.id, { to: draft.to, subject: draft.subject, body: draft.body });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
