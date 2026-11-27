// @vitest-environment jsdom
// Exercises the credit-note builder with capped prior-credit pages.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { CreditNotesPanel } from "@/components/credit-notes-panel";

const priorCredit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from(table: string) {
      let offset = 0;
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        order: () => query,
        range: (from: number) => { offset = from; return query; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === "credit_note_lines"
          ? priorCredit(offset)
          : { data: table === "invoice_line_items" ? [{ id: "line-1", description: "Part", quantity: 1005, unit_price: 10 }] : [], error: null }).then(resolve),
      };
      return query;
    },
  },
}));

it("includes prior credits from the second API page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const credits = Array.from({ length: 1_001 }, (_, index) => ({
    id: String(index), invoice_line_id: "line-1", quantity: 1,
  }));
  priorCredit.mockImplementation((offset: number) => ({ data: credits.slice(offset, offset + 1_000), error: null }));
  const host = document.createElement("div");
  const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
  try {
    await act(async () => root.render(createElement(CreditNotesPanel, {
      invoice: { id: "invoice-1", reference: "INV-1", customer: "Example Ltd", vatEnabled: false, rawStatus: "issued" },
      onChanged: vi.fn(),
    })));
    expect(button("New credit note").disabled).toBe(false);
    await act(async () => button("New credit note").click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Quantity to credit: Part"]')?.value).toBe("4");
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
