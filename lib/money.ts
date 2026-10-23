/**
 * Money maths in integer pence so previews, saved totals and PDFs agree.
 *
 * Rounding policy (audit D12): exact decimal arithmetic on the numbers as written (0.02, 7.25, 1.005), rounded to the
 * penny half away from zero, the same as Postgres round(numeric, 2). Binary floating point is never multiplied first:
 * 0.02 x 7.25 = 0.145 is 15p, not the 14p a float gives.
 */

// BigInt constants (not literals: the project targets below ES2020).
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

/** A finite number as an exact decimal: digits x 10^-scale, from its shortest round-trip string ("1.005", "1e-7"). */
function toDecimal(value: number): { digits: bigint; scale: number } {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  const [mantissa, exponentText] = String(value).toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  const negative = mantissa.startsWith("-");
  const [whole, fraction = ""] = mantissa.replace("-", "").split(".");
  let digits = BigInt(`${whole}${fraction}` || "0");
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { digits: negative ? -digits : digits, scale };
}

/** digits x 10^-scale rounded to an integer number of `unitScale` units (2 = pence), half away from zero. */
function roundToScale(digits: bigint, scale: number, unitScale: number): number {
  if (scale <= unitScale) return Number(digits * TEN ** BigInt(unitScale - scale));
  const divisor = TEN ** BigInt(scale - unitScale);
  const magnitude = digits < ZERO ? -digits : digits;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * TWO >= divisor) quotient += ONE;
  return Number(digits < ZERO ? -quotient : quotient);
}

/** Pounds -> integer pence, exactly (1.005 -> 101). */
export const toPence = (pounds: number) => {
  const { digits, scale } = toDecimal(pounds);
  return roundToScale(digits, scale, 2);
};
export const fromPence = (pence: number) => pence / 100;

/** quantity x unit price in integer pence, exact decimal product rounded once. */
export function linePence(quantity: number, unitPrice: number): number {
  const q = toDecimal(quantity);
  const p = toDecimal(unitPrice);
  return roundToScale(q.digits * p.digits, q.scale + p.scale, 2);
}

/** Number of decimal places a value is written with (0.125 -> 3, 1e-7 -> 7, 2 -> 0). */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return Infinity;
  const { digits, scale } = toDecimal(value);
  let places = scale;
  let rest = digits < ZERO ? -digits : digits;
  while (places > 0 && rest % TEN === ZERO) {
    rest /= TEN;
    places -= 1;
  }
  return places;
}

/** Supported scales: prices and money in pounds and pence, quantities to a thousandth (the stored column scales). */
export const PRICE_DECIMALS = 2;
export const QUANTITY_DECIMALS = 3;

/** vatPct: the line's rate (20, 5, 0, ...). vatExempt: outside the scope of VAT (no rate is printed). */
export type MoneyLine = {
  quantity: number; unitPrice: number; vatPct?: number; vatExempt?: boolean;
  /** The line's VAT where it was fixed when the document was made (a credit note's share of an invoice line's VAT): used instead of working it out. */
  vatAmount?: number;
};

/**
 * A £0 text-only invoice line (migration 073): quantity 0 and price 0, printed as its description only. It adds nothing to the
 * subtotal, the VAT or the VAT breakdown. (Before 073 the database refuses quantity 0, so no stored line is one.)
 */
export function isTextLine(line: { quantity: number; unitPrice?: number }): boolean {
  return Number(line.quantity) === 0 && Number(line.unitPrice ?? 0) === 0;
}

export type VatOptions = {
  /** The document's "Add VAT" switch. Off = no VAT anywhere on the document. Default true. */
  vatEnabled?: boolean;
  /** Carriage carries VAT at the standard rate. Default false: documents issued before this option keep their totals. */
  carriageVat?: boolean;
  /** Rate for lines without one, and for carriage. Default 20. */
  standardRate?: number;
};

/** One row of the VAT summary: net amount and VAT charged at one rate (exempt lines are listed separately). */
export type VatBreakdownRow = { rate: number; exempt: boolean; net: number; vat: number };

export type DocumentTotals = {
  subtotal: number;
  carriage: number;
  vat: number;
  total: number;
  /** Ordered by rate, highest first; exempt last. Empty when VAT is off. */
  vatBreakdown: VatBreakdownRow[];
};

/** VAT on a net amount in pence at `rate` percent, exact, rounded half away from zero (rates like 17.5 too). */
const vatOn = (netPence: number, rate: number) => {
  const r = toDecimal(rate);
  return roundToScale(BigInt(netPence) * r.digits, r.scale + 2, 0);
};

/**
 * VAT is rounded per line (matches JNR's existing documents), then summed. With carriageVat, carriage is taxed at the
 * standard rate. The third argument may still be a plain number (the old "default VAT %" parameter).
 */
export function documentTotals(lines: MoneyLine[], carriage = 0, options: VatOptions | number = {}): DocumentTotals {
  const opts: VatOptions = typeof options === "number" ? { standardRate: options } : options;
  const enabled = opts.vatEnabled !== false;
  const standardRate = opts.standardRate ?? 20;
  const buckets = new Map<string, { rate: number; exempt: boolean; net: number; vat: number }>();
  const bucket = (rate: number, exempt: boolean) => {
    const key = exempt ? "exempt" : String(rate);
    if (!buckets.has(key)) buckets.set(key, { rate: exempt ? 0 : rate, exempt, net: 0, vat: 0 });
    return buckets.get(key)!;
  };

  let net = 0;
  let vat = 0;
  for (const line of lines) {
    if (isTextLine(line)) continue;
    const lineNet = linePence(line.quantity, line.unitPrice);
    net += lineNet;
    if (!enabled) continue;
    const exempt = Boolean(line.vatExempt);
    const rate = exempt ? 0 : line.vatPct ?? standardRate;
    const lineVat = exempt ? 0 : line.vatAmount !== undefined ? toPence(line.vatAmount) : vatOn(lineNet, rate);
    vat += lineVat;
    const b = bucket(rate, exempt);
    b.net += lineNet;
    b.vat += lineVat;
  }

  const carriagePence = toPence(carriage);
  if (enabled && opts.carriageVat && carriagePence !== 0) {
    const carriageVat = vatOn(carriagePence, standardRate);
    vat += carriageVat;
    const b = bucket(standardRate, false);
    b.net += carriagePence;
    b.vat += carriageVat;
  }

  const vatBreakdown = [...buckets.values()]
    .sort((a, b) => Number(a.exempt) - Number(b.exempt) || b.rate - a.rate)
    .map((b) => ({ rate: b.rate, exempt: b.exempt, net: fromPence(b.net), vat: fromPence(b.vat) }));

  return { subtotal: fromPence(net), carriage: fromPence(carriagePence), vat: fromPence(vat), total: fromPence(net + carriagePence + vat), vatBreakdown };
}

/** Label for a VAT summary row: "VAT 20%", "VAT 5%", "VAT 0%" or "Exempt". */
export function vatRowLabel(row: Pick<VatBreakdownRow, "rate" | "exempt">) {
  return row.exempt ? "Exempt" : `VAT ${row.rate}%`;
}

export function gbp(value: number, fractionDigits = 2) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
}
