/**
 * Stat cards agree with the lists: the Sales Orders "Open" card counts the Open tab without Converted orders (and its click shows
 * exactly those), and the Delivery Notes card says
 * exactly what it counts (sent out, awaiting signature), which is not the "Awaiting" (not yet sent out) status.
 */
import { describe, expect, it } from "vitest";

import { awaitsCustomerPo } from "@/lib/accept-quote";
import { AWAITING_SIGNATURE_LABEL, AWAITING_SIGNATURE_STATUSES, SALES_ORDER_OPEN_CARD_STATUSES, countAwaitingSignature, countPhases, salesOrderCardCounts } from "@/lib/list-card-counts";

type Order = { status: string; ref: string; customerPo?: string };

// The Sales Orders page's phase rule: finished unless it still awaits its customer PO (lib/accept-quote).
const phaseFor = (order: Order) => (["despatched", "converted", "closed"].includes(order.status) && !awaitsCustomerPo(order) ? "done" : "open") as "open" | "done";

const orders: Order[] = [
  { status: "open", ref: "PO-1", customerPo: "PO-1" },
  { status: "confirmed", ref: "PO-2", customerPo: "PO-2" },
  { status: "converted", ref: "SO-0003" },
  { status: "despatched", ref: "PO-4", customerPo: "PO-4" },
];

describe("Sales Orders cards", () => {
  it("Open card drops Converted orders: the Open tab is 3, the card is 2 (open + confirmed)", () => {
    expect(countPhases(orders, phaseFor).open).toBe(3);
    expect(salesOrderCardCounts(orders, phaseFor).open).toBe(2);
  });

  it("live case: Open 3 = 1 open + 2 converted awaiting a PO, so the card says 1", () => {
    const live: Order[] = [{ status: "open", ref: "PO-1", customerPo: "PO-1" }, { status: "converted", ref: "SO-0001" }, { status: "converted", ref: "SO-0002" }];
    expect(countPhases(live, phaseFor).open).toBe(3);
    expect(salesOrderCardCounts(live, phaseFor).open).toBe(1);
  });

  it("the card's click (Open tab filtered to SALES_ORDER_OPEN_CARD_STATUSES) lists exactly the card's count", () => {
    const shown = orders.filter((order) => phaseFor(order) === "open" && (SALES_ORDER_OPEN_CARD_STATUSES as readonly string[]).includes(order.status));
    expect(shown).toHaveLength(salesOrderCardCounts(orders, phaseFor).open);
    expect(SALES_ORDER_OPEN_CARD_STATUSES).not.toContain("converted");
  });

  it("Confirmed and Despatched still count by status", () => {
    expect(salesOrderCardCounts(orders, phaseFor)).toMatchObject({ confirmed: 1, despatched: 1 });
  });

  it("countPhases counts every phase once", () => {
    expect(countPhases([1, 2, 3, 4], (n) => (n === 1 ? "open" : n === 2 ? "done" : "archived"))).toEqual({ open: 1, done: 1, archived: 2 });
  });
});

describe("Delivery Notes card", () => {
  const notes = [{ status: "awaiting" }, { status: "despatched" }, { status: "delivered" }, { status: "signed" }, { status: "pending" }];

  it("counts notes sent out and not signed; a note not sent out yet is not one", () => {
    expect(countAwaitingSignature(notes)).toBe(2);
    expect(countAwaitingSignature([{ status: "awaiting" }])).toBe(0);
  });

  it("its count equals the notes its click shows (the same statuses)", () => {
    const shown = notes.filter((note) => (AWAITING_SIGNATURE_STATUSES as readonly string[]).includes(note.status));
    expect(shown).toHaveLength(countAwaitingSignature(notes));
  });

  it("is labelled with what it counts", () => {
    expect(AWAITING_SIGNATURE_LABEL).toBe("Despatched or Delivered, Awaiting Signature");
    expect(AWAITING_SIGNATURE_LABEL).not.toMatch(/sent out/i);
  });
});
