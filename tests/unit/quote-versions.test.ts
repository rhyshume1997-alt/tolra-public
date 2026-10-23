/**
 * Quote versions, partial acceptance and per-line part details (migration 068): the app's side. The database side (revise_quote,
 * accept_quote's p_lines, the order / job / invoice carrying ordered lines only) is tests/db/quote-versions.test.ts.
 */
import { describe, expect, it } from "vitest";

import { acceptOutcome, type AcceptQuoteResult } from "@/lib/accept-quote";
import { orderTermsFromQuote, type QuoteLineRow } from "@/lib/order-from-quote";
import { canRecordDecision, quoteFigures, sentSince, statusCounts, storedQuoteStatus } from "@/lib/quote-status";
import { acceptedLineIds, baseQuoteRef, declinedValueByQuote, describedLine, lineReference, partField, versionChain } from "@/lib/quote-versions";

describe("a quote's number across versions", () => {
  it("is the number itself for version 1, and the number without ' vN' after", () => {
    expect(baseQuoteRef("QUO-0123", 1)).toBe("QUO-0123");
    expect(baseQuoteRef("QUO-0123 v2", 2)).toBe("QUO-0123");
    expect(baseQuoteRef("QUO-0123 v12", 12)).toBe("QUO-0123");
    expect(baseQuoteRef("QUO-0123", undefined)).toBe("QUO-0123");
    // A version-1 number that happens to end like a suffix is left alone (only later versions carry one).
    expect(baseQuoteRef("ACME v2", 1)).toBe("ACME v2");
  });

  it("follows the chain both ways, oldest first, from any version", () => {
    const v1 = { id: "a", previousVersionId: null, ref: "QUO-1" };
    const v2 = { id: "b", previousVersionId: "a", ref: "QUO-1 v2" };
    const v3 = { id: "c", previousVersionId: "b", ref: "QUO-1 v3" };
    const other = { id: "z", previousVersionId: null, ref: "QUO-2" };
    const rows = [v3, other, v1, v2];
    for (const from of [v1, v2, v3]) expect(versionChain(rows, from).map((r) => r.ref)).toEqual(["QUO-1", "QUO-1 v2", "QUO-1 v3"]);
    expect(versionChain(rows, other)).toEqual([other]);
    // A version whose earlier one isn't loaded starts the chain.
    expect(versionChain([v2, v3], v3).map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("superseded quotes", () => {
  it("are a stored status of their own, never decided, and in no open figure or win rate", () => {
    expect(storedQuoteStatus("superseded")).toBe("superseded");
    expect(canRecordDecision("superseded")).toBe(false);
    const today = "2026-10-18";
    const rows = [
      { status: "superseded", total_value: 500, valid_until: "2026-12-01" },
      { status: "sent", total_value: 450, valid_until: "2026-12-01" },
      { status: "accepted", total_value: 450 },
    ];
    const figures = quoteFigures(rows, today);
    expect(figures.open).toEqual({ count: 1, value: 450 });
    expect(figures.byStatus.superseded).toEqual({ count: 1, value: 500 });
    expect(figures.winRate).toBe(100);
    expect(statusCounts([{ status: "superseded" }, { status: "sent" }])).toMatchObject({ superseded: 1, sent: 1 });
  });

  it("'Quotes sent this month' counts each quote once, however many of its versions went out", () => {
    const rows = [
      { quote_ref: "QUO-0123", version: 1, sent_at: "2026-10-02T09:00:00Z" },
      { quote_ref: "QUO-0123 v2", version: 2, sent_at: "2026-10-09T09:00:00Z" },
      { quote_ref: "QUO-0123 v3", version: 3, sent_at: "2026-10-12T09:00:00Z" },
      { quote_ref: "QUO-0124", version: 1, sent_at: "2026-10-03T09:00:00Z" },
      { quote_ref: "QUO-0125", version: 1, sent_at: "2026-09-30T09:00:00Z" },
      { quote_ref: "QUO-0125 v2", version: 2, sent_at: "2026-10-01T08:00:00Z" },
      { quote_ref: "QUO-0126", version: 1 },
    ];
    expect(sentSince(rows, "2026-10-01")).toBe(3);
    // Rows without a reference still count one each (as before 068).
    expect(sentSince([{ sent_at: "2026-10-05" }, { sent_at: "2026-10-06" }], "2026-10-01")).toBe(2);
  });
});

describe("one row per part", () => {
  it("names the part, the drawing and its revision, or nothing", () => {
    expect(lineReference({ partNumber: "P-100", drawingNumber: "D-200", drawingRevision: "C" })).toBe("Part P-100; Dwg D-200 rev C");
    expect(lineReference({ partNumber: " P-100 ", drawingNumber: "", drawingRevision: null })).toBe("Part P-100");
    expect(lineReference({ drawingNumber: "D-200" })).toBe("Dwg D-200");
    expect(lineReference({ drawingRevision: "B" })).toBe("Rev B");
    expect(lineReference({})).toBe("");
  });

  it("prints under the description on the quote, and blanks are stored as none", () => {
    expect(describedLine("Bracket", { partNumber: "P-1" })).toBe("Bracket\nPart P-1");
    expect(describedLine("Bracket", {})).toBe("Bracket");
    expect(partField("  D-9 ")).toBe("D-9");
    expect(partField("   ")).toBeNull();
    expect(partField(undefined)).toBeNull();
  });
});

describe("partial acceptance", () => {
  it("sends no line list when every line is ticked (the whole quote, as before), else the ticked lines in quote order", () => {
    expect(acceptedLineIds(["a", "b", "c"], new Set(["c", "b", "a"]))).toBeNull();
    expect(acceptedLineIds(["a", "b", "c"], new Set(["c", "a"]))).toEqual(["a", "c"]);
    expect(() => acceptedLineIds(["a", "b"], new Set())).toThrow(/at least one line/);
    // A tick on a line that isn't on the quote counts for nothing.
    expect(acceptedLineIds(["a", "b"], new Set(["a", "x"]))).toEqual(["a"]);
  });

  const line = (quantity: number, unit_price: number, vat_pct: number, declined = false): QuoteLineRow => ({ quantity, unit_price, vat_pct, vat_exempt: false, declined });

  it("the order holds the ordered lines only, checked against their own VAT, not the whole quote's total", () => {
    // Whole quote: 100 + 50 at 20% = 180 gross. Only the first line ordered: 100 net, 120 gross.
    expect(orderTermsFromQuote({ vat_enabled: true, total_value: 180 }, [line(1, 100, 20), line(1, 50, 20, true)], true)).toEqual({ ok: true, value: 100, vatOn: true, vat: "20" });
    // With nothing declined the quote's stored total is still what is checked (058).
    expect(orderTermsFromQuote({ vat_enabled: true, total_value: 999 }, [line(1, 100, 20)], true)).toMatchObject({ ok: false });
  });

  it("declining the line at another VAT rate lets one order hold the rest", () => {
    const lines = [line(1, 100, 20), line(1, 50, 5)];
    expect(orderTermsFromQuote({ vat_enabled: true, total_value: 172.5 }, lines, true)).toMatchObject({ ok: false });
    expect(orderTermsFromQuote({ vat_enabled: true, total_value: 172.5 }, [lines[0], { ...lines[1], declined: true }], true)).toEqual({ ok: true, value: 100, vatOn: true, vat: "20" });
  });

  it("Accepted counts only the ordered lines: the quote's total less its declined lines, each with its own VAT", () => {
    // 100.00 + 50.03 at 20%: the quote is 180.04 (VAT 20.00 + 10.01, rounded per line). The 50.03 line was declined: 60.04.
    const declined = declinedValueByQuote([{ quote_id: "q1", quantity: 1, unit_price: 50.03, vat_pct: 20, vat_exempt: false }], () => true);
    expect(declined.get("q1")).toBe(60.04);
    // No VAT on the quote: the declined line's net only; several declined lines add up per quote.
    const noVat = declinedValueByQuote([
      { quote_id: "q2", quantity: 2, unit_price: 10, vat_pct: 20, vat_exempt: false },
      { quote_id: "q2", quantity: 1, unit_price: 5.5, vat_pct: 20, vat_exempt: false },
    ], () => false);
    expect(noVat.get("q2")).toBe(25.5);
    const figures = quoteFigures([
      { status: "accepted", total_value: 180.04, declined_value: declined.get("q1") },
      { status: "accepted", total_value: 300 },
      // A declined value on anything but an accepted quote changes nothing (only acceptance declines lines).
      { status: "sent", total_value: 90, declined_value: 40, valid_until: "2099-01-01" },
    ], "2026-10-18");
    expect(figures.byStatus.accepted).toEqual({ count: 2, value: 420 });
    expect(figures.open).toEqual({ count: 1, value: 90 });
  });

  it("the accept message says how many lines went on the order", () => {
    const base: AcceptQuoteResult = {
      quote_id: "q1", quote_ref: "QUO-0101 v2", accepted: true, so_id: "s1", so_number: "PO-9", so_created: true, provisional: false,
      job_id: "j1", job_no: "J-0101", job_created: true, auto_convert: true, needs: null, reason: null, job_reason: null, lines_ordered: 2, lines_declined: 1,
    };
    expect(acceptOutcome(base).message).toBe("QUO-0101 v2 accepted. Sales order PO-9 for 2 of 3 lines created and job J-0101 made, not started.");
    expect(acceptOutcome({ ...base, lines_declined: 0, lines_ordered: 3 }).message).toBe("QUO-0101 v2 accepted. Sales order PO-9 created and job J-0101 made, not started.");
    // Already accepted: no count (nothing was chosen this time).
    expect(acceptOutcome({ ...base, accepted: false }).message).toBe("QUO-0101 v2 was already accepted: it has sales order PO-9 and job J-0101. Nothing was changed.");
  });
});
