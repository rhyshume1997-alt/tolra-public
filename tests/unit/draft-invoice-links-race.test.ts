import { describe, expect, it } from "vitest";

import { buildDraftReplace, draftFormFrom, lineRowsLocked, linesWithLoadedLinks, removeDraftLine } from "@/lib/draft-invoice-edit";

// 28 Oct (ChatGPT, confirmed by Grok): draft_invoice_balances answers by position, so a line removed while it is in flight shifted the
// next line onto the removed line's order link, and replace_draft_invoice accepts any link of the draft's orders: B billed A's balance.
const VAT = { vatEnabled: true, carriageVat: true, registered: true, standardRate: 20 };
const STORED = [
  { description: "Part A", quantity: 1, unitPrice: 10, vatPct: 20 },
  { description: "Part B", quantity: 1, unitPrice: 20, vatPct: 20 },
];
const LINK_A = "11111111-1111-4111-8111-111111111111";
const LINK_B = "22222222-2222-4222-8222-222222222222";

describe("draft invoice order links (099): no line added or removed while they load", () => {
  it("lines are locked only while the links are loading", () => {
    expect(lineRowsLocked("loading")).toBe(true);
    for (const state of ["ready", "none", "stale"]) expect(lineRowsLocked(state)).toBe(false);
  });

  it("remove A while draft_invoice_balances is in flight, then the answer lands: B keeps B's link, not A's", () => {
    const form = draftFormFrom({ date: "2026-10-28", dueDate: "2026-11-27", carriage: 0 }, STORED);
    // The editor opened: links loading. Remove A (the editor's own remove step).
    const afterRemove = removeDraftLine(form.lines, 0, "loading");
    expect(afterRemove).toBe(form.lines); // refused: still A and B
    // The delayed answer lands, in the stored order: A's link, then B's.
    const linked = linesWithLoadedLinks(afterRemove, [LINK_A, LINK_B]);
    expect(linked.map((line) => [line.description, line.orderLine])).toEqual([["Part A", LINK_A], ["Part B", LINK_B]]);
    // Now ready: removing A leaves B with its own link, and the save sends B with B's link only.
    const removed = removeDraftLine(linked, 0, "ready");
    expect(removed.map((line) => [line.description, line.orderLine])).toEqual([["Part B", LINK_B]]);
    const built = buildDraftReplace({ ...form, lines: removed }, VAT, { links: true });
    if (!built.ok) throw new Error(built.error);
    expect(built.value.lines.map((line) => [line.description, line.sales_order_line_id])).toEqual([["Part B", LINK_B]]);
  });

  it("the old order (remove before the answer lands) is the bug the lock prevents", () => {
    const form = draftFormFrom({ date: "2026-10-28", dueDate: "2026-11-27", carriage: 0 }, STORED);
    const unlocked = removeDraftLine(form.lines, 0, "ready"); // what the editor did before the lock
    const linked = linesWithLoadedLinks(unlocked, [LINK_A, LINK_B]);
    expect(linked.map((line) => [line.description, line.orderLine])).toEqual([["Part B", LINK_A]]);
  });
});
