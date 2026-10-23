import { describe, expect, it } from "vitest";

import { INVOICE_SHOW_NOTE, raisedCaption, rangeLabel } from "@/lib/range-label";

describe("rangeLabel", () => {
  it("a range inside one month", () => {
    expect(rangeLabel("2026-10-01", "2026-10-19")).toBe("1–19 Oct 2026");
  });
  it("a range across months, and across years", () => {
    expect(rangeLabel("2026-09-28", "2026-10-19")).toBe("28 Sep – 19 Oct 2026");
    expect(rangeLabel("2025-12-20", "2026-01-05")).toBe("20 Dec 2025 – 5 Jan 2026");
  });
  it("a single day", () => {
    expect(rangeLabel("2026-10-19", "2026-10-19")).toBe("19 Oct 2026");
  });
  it("returns odd input as given", () => {
    expect(rangeLabel("", "")).toBe("");
    expect(rangeLabel("soon", "2026-10-19")).toBe("soon to 2026-10-19");
  });
});

describe("Invoices captions", () => {
  it("the Raised card says the range and what is left out", () => {
    expect(raisedCaption("2026-10-01", "2026-10-19")).toBe("Issued 1–19 Oct 2026. Drafts and void are not counted.");
  });
  it("the Show note says what Done counts", () => {
    expect(INVOICE_SHOW_NOTE).toContain("every paid, void or cancelled invoice");
  });
});
