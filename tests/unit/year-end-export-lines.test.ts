// Simulates the PostgREST response cap in the year-end export and inspects the PDF inputs.
import { describe, expect, it, vi } from "vitest";
import { JNR_PROFILE } from "@/lib/company";
import { MAX_LIST_ROWS } from "@/lib/fetch-all";

const state = vi.hoisted(() => ({ lineCount: 0, pages: [] as number[], rendered: [] as string[][] }));
vi.mock("@react-pdf/renderer", async (original) => ({
  ...await original<typeof import("@react-pdf/renderer")>(),
  pdf: (element: { props: { data: { items: { description: string }[] } } }) => {
    state.rendered.push(element.props.data.items.map((item) => item.description));
    return { toBlob: async () => new Blob(["fixture"]) };
  },
}));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/customers", () => ({ resolveCustomerAddress: async () => ({ name: "Example Customer", addressLines: [] }) }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const response = (from = 0, to = 999) => {
        if (table === "delivery_note_items") {
          state.pages.push(from);
          const end = Math.min(to + 1, from + 1_000, state.lineCount);
          const data = Array.from({ length: Math.max(0, end - from) }, (_, i) => ({
            id: String(from + i), description: `Item ${from + i + 1}`, quantity: 1,
          }));
          return { data, error: null };
        }
        const data = table === "delivery_notes" && from === 0 ? [
          { id: "note-1", dn_ref: "DN-TEST-1", delivery_date: "2026-01-10", customer: "Example Customer", status: "despatched" },
        ] : [];
        return { data, error: null };
      };
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range: async (from: number, to: number) => response(from, to),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
      };
      return query;
    },
  },
}));

const { buildYearEndZip } = await import("@/lib/year-end-export");

function build(lineCount: number) {
  state.lineCount = lineCount;
  state.pages = [];
  state.rendered = [];
  return buildYearEndZip("2026-01-01", "2026-12-31", JNR_PROFILE);
}

describe("year-end export document lines", () => {
  it("includes the final delivery-note line beyond the API response cap", async () => {
    const result = await build(1_001);
    expect(result.problems).toEqual([]);
    expect(state.rendered[0]).toHaveLength(1_001);
    expect(state.rendered[0].at(-1)).toBe("Item 1001");
    expect(state.pages).toEqual([0, 1_000, 1_001]);
  });

  it("omits the PDF and records a problem when the line safety cap is reached", async () => {
    const result = await build(MAX_LIST_ROWS);
    expect(state.rendered).toEqual([]);
    expect(result.summary[0].pdf).toBe("");
    expect(result.problems).toContainEqual(expect.stringMatching(/Delivery note DN-TEST-1: PDF not included .*too many line items/i));
  });
});
