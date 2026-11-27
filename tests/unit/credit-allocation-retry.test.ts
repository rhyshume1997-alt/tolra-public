// @vitest-environment jsdom
// Exercises the credit panel with simulated RPC replies; no allocations are written.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreditNotesPanel } from "@/components/credit-notes-panel";

const { rpc, success } = vi.hoisted(() => ({ rpc: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success } }));
vi.mock("@/components/who-when", () => ({ WhoWhen: () => null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc,
    from(table: string) {
      const data = table === "credit_notes"
        ? [{ id: "credit-1", credit_ref: "CN-1", status: "issued", credit_date: "2026-11-01", total: 100, allocated_amount: 0 }]
        : [];
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        order: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      };
      return query;
    },
  },
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const group = () => host.querySelector('[aria-label="Apply CN-1"]')!;
const input = () => group().querySelector("input")!;
const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll("button")].find((element) => element.textContent === label)!;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  rpc.mockReset();
  success.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(CreditNotesPanel, {
    invoice: { id: "invoice-1", reference: "INV-1", customer: "Example Ltd", vatEnabled: false, rawStatus: "issued" },
    onChanged: vi.fn(),
  })));
  await act(async () => button("Apply credit").click());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the original allocation amount and request ID when the response is lost", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: "Connection lost" } })
    .mockResolvedValueOnce({ data: null, error: { code: "42501", message: "Not authorised" } })
    .mockResolvedValueOnce({ data: { balance_due: 25, customer_credit: 0, repeated: true }, error: null });
  await act(async () => button("Apply credit", group()).click());
  expect(input().disabled).toBe(true);
  expect(button("Cancel", group()).disabled).toBe(true);
  expect(button("Apply credit").disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("may have been applied");
  await act(async () => button("Apply credit", group()).click());
  expect(input().disabled).toBe(true);
  await act(async () => button("Apply credit", group()).click());
  expect(rpc.mock.calls).toHaveLength(3);
  expect(rpc.mock.calls[0][1]).toMatchObject({ p_credit: "credit-1", p_amount: 100 });
  expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  expect(rpc.mock.calls[2]).toEqual(rpc.mock.calls[0]);
  expect(success).toHaveBeenCalledWith("£100.00 applied to INV-1. Balance due £25.00.");
});

it("allows editing or cancelling after a definite first refusal", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "That is more than the credit note has left." } });
  await act(async () => button("Apply credit", group()).click());
  expect(input().disabled).toBe(false);
  expect(button("Cancel", group()).disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("more than the credit note has left");
});
