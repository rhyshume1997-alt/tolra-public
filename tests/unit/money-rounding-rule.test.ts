import { describe, expect, it } from "vitest";

import { documentTotals, linePence, toPence } from "@/lib/money";
import { documentCases, lineCases, pennyCases } from "../fixtures/money-rounding-cases";

describe("CL normal money: nearest penny, positive halves up", () => {
  it.each(pennyCases)("$pounds pounds becomes $pence pence", ({ pounds, pence }) => {
    expect(toPence(pounds)).toBe(pence);
  });

  it.each(lineCases)("$quantity x $unitPrice rounds once to $pence pence", ({ quantity, unitPrice, pence }) => {
    expect(linePence(quantity, unitPrice)).toBe(pence);
  });

  it.each(documentCases)("$name", ({ lines, subtotal, vat, total }) => {
    const actual = documentTotals([...lines]);
    expect(toPence(actual.subtotal)).toBe(subtotal);
    expect(toPence(actual.vat)).toBe(vat);
    expect(toPence(actual.total)).toBe(total);
  });
});
