import { describe, expect, it } from "vitest";

import { orderTermsFromQuote, type QuoteLineRow } from "@/lib/order-from-quote";

const line = (quantity: number, unit_price: number, vat_pct: number, vat_exempt = false): QuoteLineRow => ({ quantity, unit_price, vat_pct, vat_exempt });

describe("sales order from an accepted quote (R2)", () => {
  it("copies VAT on at the quote's single rate; the value is net of VAT", () => {
    expect(orderTermsFromQuote({ vat_enabled: true }, [line(2, 10.5, 5), line(1, 4, 5)], true)).toEqual({ ok: true, value: 25, vatOn: true, vat: "5" });
    expect(orderTermsFromQuote({ vat_enabled: true }, [line(1, 100, 0)], true)).toMatchObject({ ok: true, vatOn: true, vat: "0" });
    expect(orderTermsFromQuote({ vat_enabled: true }, [line(1, 100, 0, true), line(3, 1, 20, true)], true)).toMatchObject({ ok: true, value: 103, vatOn: true, vat: "exempt" });
  });

  it("copies VAT off from the quote (not the company default)", () => {
    expect(orderTermsFromQuote({ vat_enabled: false }, [line(1, 99.99, 20), line(1, 1, 5)], true)).toMatchObject({ ok: true, value: 100.99, vatOn: false });
  });

  it("no VAT when the company isn't VAT registered and the quote had none", () => {
    expect(orderTermsFromQuote({ vat_enabled: false }, [line(1, 50, 20)], false)).toMatchObject({ ok: true, vatOn: false });
  });

  it("refuses when the accepted quote charged VAT the order wouldn't (company no longer VAT registered)", () => {
    const terms = orderTermsFromQuote({ vat_enabled: true, total_value: 60 }, [line(1, 50, 20)], false);
    expect(terms).toMatchObject({ ok: false });
    expect(!terms.ok && terms.reason).toContain("£60.00");
  });

  it("refuses when per-line VAT rounding differs from the order's: two 3p lines at 20%, quote 8p, order 7p", () => {
    const lines = [line(1, 0.03, 20), line(1, 0.03, 20)];
    const terms = orderTermsFromQuote({ vat_enabled: true, total_value: 0.08 }, lines, true);
    expect(terms).toMatchObject({ ok: false });
    expect(!terms.ok && terms.reason).toContain("£0.07 (VAT £0.01)");
    expect(!terms.ok && terms.reason).toContain("£0.08 (VAT £0.02)");
    // Without a stored total the lines' own per-line rounding still gives 8p, so it is still refused.
    expect(orderTermsFromQuote({ vat_enabled: true }, lines, true)).toMatchObject({ ok: false });
    // Same lines with VAT off: nothing to round, so it links at 6p.
    expect(orderTermsFromQuote({ vat_enabled: false, total_value: 0.06 }, lines, true)).toEqual({ ok: true, value: 0.06, vatOn: false, vat: "20" });
  });

  it("links when the order's VAT and gross match the quote's to the penny", () => {
    expect(orderTermsFromQuote({ vat_enabled: true, total_value: 300 }, [line(10, 25, 20)], true)).toMatchObject({ ok: true, value: 250, vat: "20" });
    expect(orderTermsFromQuote({ vat_enabled: true, total_value: 105 }, [line(4, 25, 5)], true)).toMatchObject({ ok: true, value: 100, vat: "5" });
  });

  it("refuses when the stored quote total doesn't match", () => {
    expect(orderTermsFromQuote({ vat_enabled: true, total_value: 299.99 }, [line(10, 25, 20)], true)).toMatchObject({ ok: false });
  });

  it("refuses lines at different rates rather than blending them", () => {
    const terms = orderTermsFromQuote({ vat_enabled: true }, [line(1, 100, 20), line(1, 100, 5)], true);
    expect(terms).toMatchObject({ ok: false });
    expect(!terms.ok && terms.reason).toContain("different VAT rates");
    expect(orderTermsFromQuote({ vat_enabled: true }, [line(1, 100, 20), line(1, 100, 20, true)], true)).toMatchObject({ ok: false });
  });

  it("refuses a rate a sales order can't hold, and a quote with no lines", () => {
    const odd = orderTermsFromQuote({ vat_enabled: true }, [line(1, 100, 17.5)], true);
    expect(!odd.ok && odd.reason).toContain("17.5%");
    expect(orderTermsFromQuote({ vat_enabled: true }, [], true)).toMatchObject({ ok: false });
  });

  it("fractional quantities round per line as the quote does", () => {
    expect(orderTermsFromQuote({ vat_enabled: true }, [line(0.02, 7.25, 20)], true)).toMatchObject({ ok: true, value: 0.15 });
  });
});
