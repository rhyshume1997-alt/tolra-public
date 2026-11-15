/**
 * BOUNDARY: components/portal/format.ts. Inputs: ISO date strings (or null). Output: a UK date for display, or a dash. Pure; no money
 * here (money goes through lib/money.ts gbp).
 */
export function portalDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}
