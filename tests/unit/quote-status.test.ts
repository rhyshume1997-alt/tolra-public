import { describe, expect, it } from "vitest";

import { canRecordDecision, DEFAULT_QUOTE_VALIDITY_DAYS, defaultValidUntil, effectiveQuoteStatus, newestFirst, quoteAcceptBlock, quoteFigures, quoteSendBlock, quoteValidityDays, statusCounts, uploadSummary, sentSince, storedQuoteStatus } from "@/lib/quote-status";

describe("quote lifecycle (audit D1)", () => {
  const today = "2026-10-09";
  it("derives expiry only for undecided quotes past their valid-until date", () => {
    expect(effectiveQuoteStatus("sent", "2026-10-08", today)).toBe("expired"); // yesterday
    expect(effectiveQuoteStatus("sent", "2026-10-09", today)).toBe("sent"); // valid through today
    expect(effectiveQuoteStatus("draft", "2026-12-01", today)).toBe("draft"); // future
    expect(effectiveQuoteStatus("draft", "2026-10-08", today)).toBe("expired"); // go-live polish 19b: past its date and undecided = Expired (stored status stays draft)
    expect(effectiveQuoteStatus("sent", "", today)).toBe("sent"); // no validity
  });
  it("never expires a decision", () => {
    expect(effectiveQuoteStatus("accepted", "2020-01-01", today)).toBe("accepted");
    expect(effectiveQuoteStatus("rejected", "2020-01-01", today)).toBe("rejected");
  });
  it("records decisions only on draft or sent quotes", () => {
    expect(["draft", "sent", "accepted", "rejected", "expired"].map((s) => canRecordDecision(storedQuoteStatus(s)))).toEqual([true, true, false, false, false]);
    expect(storedQuoteStatus("weird")).toBe("draft");
  });
});

import { quoteKeyValues, quoteMessage } from "@/components/pdf/QuotePDF";

describe("quote PDF content (audit D21)", () => {
  const company = { defaultQuoteTerms: "Valid for 30 days", defaultCustomerMessage: ["Please use the quote number as reference"] };
  it("prints the validity date, or omits the line rather than contradict the terms", () => {
    expect(quoteKeyValues({ number: "QUO-1", date: "09/10/2026", validUntil: "08/11/2026" }, company)).toContainEqual({ label: "Valid Until", value: "08/11/2026" });
    for (const validUntil of ["", "  ", undefined]) {
      const rows = quoteKeyValues({ number: "QUO-1", date: "09/10/2026", validUntil, terms: "Valid for 7 days" }, company);
      expect(rows.map((r) => r.label)).toEqual(["Our Quote No.", "Date", "Terms"]);
      expect(JSON.stringify(rows)).not.toContain("Not set");
      expect(rows).toContainEqual({ label: "Terms", value: "Valid for 7 days" });
    }
  });
  it("prints the scope before the customer message, never internal notes (not an input)", () => {
    expect(quoteMessage({ scope: "Machine 40 flanges to drawing 12-B", customerMessage: ["Thanks"] }, company)).toEqual(["Scope: Machine 40 flanges to drawing 12-B", "Thanks"]);
    expect(quoteMessage({ scope: " " }, company)).toEqual(company.defaultCustomerMessage);
  });
});

describe("quote figures: one definition for the Quote Generator and the dashboard (go-live polish 18, 19)", () => {
  const today = "2026-10-14";
  // The live audit's shape: 6 drafts and 5 sent in the database; 4 of the sent are past their date.
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({ status: "draft", valid_until: i === 0 ? "2026-09-01" : "2026-11-30", total_value: 1000 })),
    { status: "sent", valid_until: "2026-11-01", total_value: 882 },
    ...Array.from({ length: 4 }, () => ({ status: "sent", valid_until: "2026-09-30", total_value: 5000 })),
    { status: "accepted", valid_until: "2026-01-01", total_value: 300 },
    { status: "rejected", valid_until: null, total_value: 50 },
  ];
  it("open = sent, still valid, undecided; drafts = not sent and within date; expired = past date and undecided", () => {
    const f = quoteFigures(rows, today);
    expect(f.open).toEqual({ count: 1, value: 882 });
    expect(f.drafts).toEqual({ count: 5, value: 5000 });
    expect(f.byStatus.expired).toEqual({ count: 5, value: 21000 });
    expect(f.byStatus.accepted.count).toBe(1);
    expect(f.expiredSent).toEqual({ count: 4, value: 20000 });
    // accepted / (accepted + rejected + expired-sent) = 1 / (1 + 1 + 4): the expired draft is not counted.
    expect(f.winRate).toBe(Math.round((1 / 6) * 100));
    expect(quoteFigures([], today)).toMatchObject({ open: { count: 0, value: 0 }, winRate: null });
  });
  it("win rate counts only quotes that were sent: an expired draft never changes it", () => {
    const sentOnes = [
      { status: "accepted", valid_until: "2026-01-01", total_value: 100 },
      { status: "accepted", valid_until: null, total_value: 100 },
      { status: "rejected", valid_until: "2026-12-31", total_value: 100 },
      { status: "sent", valid_until: "2026-09-30", total_value: 100 }, // expired, had been sent
    ];
    const expiredDraft = { status: "draft", valid_until: "2026-09-30", total_value: 100 };
    expect(quoteFigures(sentOnes, today).winRate).toBe(50); // 2 / (2 + 1 + 1)
    expect(quoteFigures([...sentOnes, expiredDraft], today).winRate).toBe(50);
    expect(quoteFigures([...sentOnes, expiredDraft, expiredDraft], today).byStatus.expired.count).toBe(3);
    expect(quoteFigures([expiredDraft], today).winRate).toBeNull();
  });
  it("adds money in pence", () => {
    expect(quoteFigures([{ status: "sent", total_value: 0.1 }, { status: "sent", total_value: 0.2 }], today).open.value).toBe(0.3);
  });
  it("sent this month counts by the send date", () => {
    expect(sentSince([{ sent_at: "2026-10-01T09:00:00Z" }, { sent_at: "2026-09-30T23:00:00Z" }, { sent_at: null }], "2026-10-01")).toBe(1);
  });
  it("lists newest first, the same order on every load", () => {
    const list = newestFirst([{ ref: "QUO-0001", date: "2026-09-01T00:00:00Z" }, { ref: "JNR-Q-77", date: "2026-10-01T00:00:00Z" }, { ref: "QUO-0002", date: "2026-10-01T00:00:00Z" }, { ref: "QUO-0003" }]);
    expect(list.map((q) => q.ref)).toEqual(["QUO-0002", "JNR-Q-77", "QUO-0001", "QUO-0003"]);
  });
  it("a quote sent with no valid-until date gets the company's validity, else 30 days", () => {
    expect(quoteValidityDays("Valid for 14 days")).toBe(14);
    expect(quoteValidityDays("Quotations are valid for 7 days.")).toBe(7);
    expect(quoteValidityDays("Payment 30 days net")).toBe(DEFAULT_QUOTE_VALIDITY_DAYS);
    expect(quoteValidityDays(null)).toBe(30);
    expect(defaultValidUntil("2026-10-14", 30)).toBe("2026-11-13");
    expect(defaultValidUntil("2026-12-20", 30)).toBe("2027-01-19");
  });
});

describe("a £0.00 quote cannot be sent", () => {
  it("blocks zero, missing and unreadable totals with a message that says what to do", () => {
    for (const total of [0, "0", "0.00", null, undefined, "", "abc", 0.004]) {
      expect(quoteSendBlock("QUO-0007", total)).toBe("QUO-0007 is £0.00, so it can't be sent. Add prices to its lines first.");
    }
  });

  it("lets a priced quote through (even one penny)", () => {
    for (const total of [0.01, 1, "882.50", 1200]) expect(quoteSendBlock("QUO-0007", total)).toBeNull();
  });
});

describe("quoteAcceptBlock", () => {
  it("refuses a total of zero, negative or unreadable", () => {
    for (const total of [0, "0.00", -5, null, undefined, "abc"]) expect(quoteAcceptBlock(total)).toBe("A quote for £0.00 can't be accepted. Add a price or decline it.");
  });
  it("refuses a quote with no lines", () => {
    expect(quoteAcceptBlock(100, 0)).toBe("A quote with no lines can't be accepted. Add a line or decline it.");
  });
  it("refuses ticked lines that sum to zero", () => {
    expect(quoteAcceptBlock(100, 2, 0)).toBe("The ticked lines come to £0.00, so they can't be accepted. Tick a priced line or decline the quote.");
  });
  it("lets a normal quote through", () => {
    expect(quoteAcceptBlock(882.5)).toBeNull();
    expect(quoteAcceptBlock("0.01", 3, 0.01)).toBeNull();
  });
});

describe("legend counts follow the quotes in scope", () => {
  const rows = [{ status: "draft" }, { status: "sent" }, { status: "sent" }, { status: "expired" }, { status: "accepted" }] as const;
  it("counts each status over the rows it is given", () => {
    expect(statusCounts([...rows])).toEqual({ draft: 1, sent: 2, accepted: 1, rejected: 0, expired: 1, superseded: 0 });
    // Open scope: draft + sent only, so the legend shows no Expired quotes where none are listed.
    expect(statusCounts(rows.filter((r) => r.status === "draft" || r.status === "sent"))).toEqual({ draft: 1, sent: 2, accepted: 0, rejected: 0, expired: 0, superseded: 0 });
    expect(statusCounts([])).toEqual({ draft: 0, sent: 0, accepted: 0, rejected: 0, expired: 0, superseded: 0 });
  });
});

describe("uploadSummary", () => {
  it("counts only what went up and names what was skipped", () => {
    expect(uploadSummary(2, [])).toBe("2 attachments uploaded");
    expect(uploadSummary(1, ["big.pdf"])).toBe("1 attachment uploaded");
    expect(uploadSummary(0, ["big.pdf"])).toBe("Nothing was uploaded: big.pdf is larger than 20 MB.");
    expect(uploadSummary(0, ["a", "b"])).toBe("Nothing was uploaded: 2 files are larger than 20 MB.");
    expect(uploadSummary(0, [])).toBe("Nothing was uploaded.");
  });
});
