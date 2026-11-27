// @vitest-environment jsdom
// Exercises the credit-note builder with a failed prior-credit read and a successful retry.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { CreditNotesPanel } from "@/components/credit-notes-panel";

const priorCredit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        order: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === "credit_note_lines"
          ? priorCredit()
          : { data: table === "invoice_line_items" ? [{ id: "line-1", description: "Part", quantity: 5, unit_price: 10 }] : [], error: null }).then(resolve),
      };
      return query;
    },
  },
}));

it("blocks a new draft until a successful read establishes the remaining quantity", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  priorCredit.mockResolvedValueOnce({ data: null, error: { code: "57014" } })
    .mockResolvedValueOnce({ data: [{ invoice_line_id: "line-1", quantity: 2 }], error: null });
  const host = document.createElement("div");
  const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  try {
    await act(async () => root.render(createElement(CreditNotesPanel, {
      invoice: { id: "invoice-1", reference: "INV-1", customer: "Example Ltd", vatEnabled: false, rawStatus: "issued" },
      onChanged: vi.fn(),
    })));
    expect(button("New credit note").disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("load the credit notes");
    await act(async () => button("Retry").click());
    expect(button("New credit note").disabled).toBe(false);
    await act(async () => button("New credit note").click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Quantity to credit: Part"]')?.value).toBe("3");
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
