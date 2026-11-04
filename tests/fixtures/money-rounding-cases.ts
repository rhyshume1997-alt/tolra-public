// Normal-money penny rules. Costing's Python half-to-even fixtures are separate and unchanged.
export const pennyCases = [
  { pounds: 0.1249, pence: 12 },
  { pounds: 0.125, pence: 13 },
  { pounds: 0.135, pence: 14 },
  { pounds: 0.145, pence: 15 },
  { pounds: 0.1351, pence: 14 },
  { pounds: 1.005, pence: 101 },
  { pounds: 2.675, pence: 268 },
  { pounds: -0.125, pence: -13 },
  { pounds: -0.135, pence: -14 },
  { pounds: -0.145, pence: -15 },
  { pounds: 0, pence: 0 },
  { pounds: 1e-7, pence: 0 },
] as const;

export const lineCases = [
  { quantity: 0.27, unitPrice: 0.5, pence: 14 },
  { quantity: 0.25, unitPrice: 0.5, pence: 13 },
  { quantity: 0.29, unitPrice: 0.5, pence: 15 },
  { quantity: 0.02, unitPrice: 7.25, pence: 15 },
  { quantity: -0.27, unitPrice: 0.5, pence: -14 },
] as const;

export const documentCases = [
  { name: "VAT tie rounds up", lines: [{ quantity: 1, unitPrice: 0.05, vatPct: 10 }], subtotal: 5, vat: 1, total: 6 },
  { name: "VAT rounds each line before summing", lines: [{ quantity: 1, unitPrice: 0.03, vatPct: 20 }, { quantity: 1, unitPrice: 0.03, vatPct: 20 }], subtotal: 6, vat: 2, total: 8 },
  { name: "fractional line rounds before VAT", lines: [{ quantity: 0.27, unitPrice: 0.5, vatPct: 20 }], subtotal: 14, vat: 3, total: 17 },
  { name: "negative adjustment keeps existing away-from-zero ties", lines: [{ quantity: -1, unitPrice: 0.05, vatPct: 10 }], subtotal: -5, vat: -1, total: -6 },
] as const;
