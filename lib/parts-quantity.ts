/** The quantity required (M) as a usable count: a whole number of 1 or more, else null (a job without one is not counted; lib/job-parts). No imports, so pure shaping code can use it. */
export function requiredParts(quantity: number | string | null | undefined): number | null {
  const n = typeof quantity === "string" ? (quantity.trim() === "" ? NaN : Number(quantity)) : quantity;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}
