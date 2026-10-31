/**
 * The Numbers page (admin only): the history questions the Overview does not answer. Pure calculations only: the page
 * (app/(dashboard)/numbers/page.tsx) reads the rows and passes them in, so every figure is worked out from rows named at the call
 * and can be tested without a database. Money is added in pence (lib/money), so no figure drifts by a penny.
 *
 * The three questions, and the one source each figure comes from:
 *   1. Which customers are we relying on? Invoiced ex VAT per customer over the chosen months (invoices, less credit_notes).
 *   2. Are invoices turning into cash? Per month: invoiced ex VAT (invoices, less credit_notes) against money received
 *      (invoice_payments by paid_on, reversals included). The gap is "invoiced less received in the month", NOT money owed: a
 *      payment can settle an invoice from an earlier month.
 *   3. Where is machine time going? Recorded machine_runs per machine, clipped to the chosen months, overlaps on a machine once.
 *
 * Rules (the same as the Overview: invoiceNetPence, isInvoiced and the row types are imported from lib/overview-metrics, so the two
 * pages cannot drift apart; tests/unit/numbers-overview-reconcile.test.ts checks that they agree month by month):
 *   - Invoiced (ex VAT): an issued invoice counts on its invoice date (else the day it was made, London) at total minus VAT. A draft,
 *     void or cancelled invoice never counts. An issued credit note takes its own total minus VAT off, ONCE, on its own credit date:
 *     the credited invoice stays counted where it was issued, so nothing is counted twice and a credit in a later month lowers that
 *     later month. A draft credit note is not a credit yet.
 *   - Months are Europe/London calendar months (first day to last day, across the clocks going forward and back): a month is a set of
 *     London dates, and for timestamps the month is the London instant of its first midnight to the next month's first midnight.
 *   - Nothing is guessed: an invoice with no figures at all makes that figure unknown (null), never zero.
 */
import { calendarDate, toDateInput } from "@/lib/dates";
import { fromPence, toPence } from "@/lib/money";
import { invoiceNetPence, isInvoiced, type CreditMetricRow, type InvoiceMetricRow } from "@/lib/overview-metrics";
import { invoiceStatus } from "@/lib/receivables";

const HOUR_MS = 3_600_000;
const LONDON = "Europe/London";

// The same rows and the same rules as the Overview, so these are its types and its two helpers, not copies. Re-exported so the page and
// the tests keep importing them from here.
export { invoiceNetPence, isInvoiced };
export type NumberInvoice = InvoiceMetricRow;
export type NumberCredit = CreditMetricRow;

export type NumberPayment = { amount: number | string | null; paid_on: string | null };
export type NumberMachine = { id: string; name: string };
export type NumberRun = { machine_id: string; started_at: string; ended_at: string | null };

/** A London calendar month. `start`/`end` are London dates (end is the first day of the next month, so the month is start <= d < end); `startAt`/`endAt` are the instants of those London midnights. */
export type Period = { key: string; label: string; start: string; end: string; startAt: string; endAt: string };

const pence = (value: number | string | null | undefined) => toPence(Number(value ?? 0) || 0);

// ---------------------------------------------------------------------------------------------------------------------------------
// Months, by the London calendar
// ---------------------------------------------------------------------------------------------------------------------------------

const londonClock = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function londonParts(ms: number): { date: string; hour: number; minute: number } {
  const parts: Record<string, string> = {};
  for (const part of londonClock.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** The instant (ISO, UTC) of 00:00 London on a London date: 23:00 UTC the evening before in summer time, 00:00 UTC in winter. */
export function londonMidnight(date: string): string {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  for (const ms of [utcMidnight - HOUR_MS, utcMidnight]) {
    const at = londonParts(ms);
    if (at.date === date && at.hour === 0 && at.minute === 0) return new Date(ms).toISOString();
  }
  // Unreachable for a real date (the clocks never change across midnight London); keep a usable answer.
  return new Date(utcMidnight).toISOString();
}

/** The `count` London calendar months ending with the month `now` falls in (oldest first). */
export function londonMonthsEnding(now: Date, count: number): Period[] {
  const [year, month] = toDateInput(now).split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const offset = i - count + 1;
    const first = new Date(Date.UTC(year, month - 1 + offset, 1));
    const next = new Date(Date.UTC(year, month - 1 + offset + 1, 1));
    const start = first.toISOString().slice(0, 10);
    const end = next.toISOString().slice(0, 10);
    return {
      key: start.slice(0, 7),
      label: new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(first),
      start,
      end,
      startAt: londonMidnight(start),
      endAt: londonMidnight(end),
    };
  });
}

/** The whole chosen stretch as one window: the first month's start to the last month's end. */
export function windowOf(periods: Period[]): { start: string; end: string; startAt: string; endAt: string } {
  const first = periods[0];
  const last = periods[periods.length - 1];
  return { start: first.start, end: last.end, startAt: first.startAt, endAt: last.endAt };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Invoiced revenue (ex VAT), credit notes off once on their own date
// ---------------------------------------------------------------------------------------------------------------------------------

/** The London calendar day an invoice counts on: its invoice date, else the day it was made. */
const invoiceDay = (row: NumberInvoice) => calendarDate(row.invoice_date) || calendarDate(row.created_at);

/** A credit note takes money off only once issued; a draft is not a credit. */
const isIssuedCredit = (credit: NumberCredit) => invoiceStatus(credit.status) === "issued";
const creditNetPence = (credit: NumberCredit) => pence(credit.total) - pence(credit.vat);

const customerOf = (name: string | null | undefined) => (name ?? "").trim() || "No customer";

/** Invoiced ex VAT per London month (key "YYYY-MM" to pounds). A month is null when one of its counted invoices has no figures. Months outside `periods` are ignored. */
export function invoicedByMonth(invoices: NumberInvoice[], credits: NumberCredit[], periods: Period[]): Map<string, number | null> {
  const buckets = new Map(periods.map((p) => [p.key, 0 as number | null]));
  for (const row of invoices) {
    if (!isInvoiced(row)) continue;
    const key = invoiceDay(row).slice(0, 7);
    if (!buckets.has(key)) continue;
    const net = invoiceNetPence(row);
    const held = buckets.get(key);
    buckets.set(key, net === null || held === null ? null : (held ?? 0) + net);
  }
  for (const credit of credits) {
    if (!isIssuedCredit(credit)) continue;
    const key = calendarDate(credit.credit_date).slice(0, 7);
    const held = buckets.get(key);
    if (held === undefined || held === null) continue;
    buckets.set(key, held - creditNetPence(credit));
  }
  return new Map([...buckets].map(([key, value]) => [key, value === null ? null : fromPence(value)]));
}

/** Money received per London month (invoice_payments by paid_on), reversals (negative rows) included on their own date. */
export function receivedByMonth(payments: NumberPayment[], periods: Period[]): Map<string, number> {
  const buckets = new Map(periods.map((p) => [p.key, 0]));
  for (const payment of payments) {
    const key = calendarDate(payment.paid_on).slice(0, 7);
    if (!buckets.has(key)) continue;
    buckets.set(key, buckets.get(key)! + pence(payment.amount));
  }
  return new Map([...buckets].map(([key, value]) => [key, fromPence(value)]));
}

export type CashMonth = { key: string; label: string; invoiced: number | null; received: number | null; gap: number | null };

/** Per month: invoiced, received and "invoiced less received in the month" (not money owed). A figure that could not be read is null, never 0. */
export function cashByMonth(periods: Period[], invoiced: Map<string, number | null> | null, received: Map<string, number> | null): CashMonth[] {
  return periods.map((p) => {
    const inv = invoiced ? invoiced.get(p.key) ?? null : null;
    const rec = received ? received.get(p.key) ?? null : null;
    return { key: p.key, label: p.label, invoiced: inv, received: rec, gap: inv === null || rec === null ? null : fromPence(toPence(inv) - toPence(rec)) };
  });
}

/** The sum of a column of months in pounds; null when any month in it is unknown. */
export function sumOrNull(values: Array<number | null>): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += toPence(value);
  }
  return fromPence(total);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Customer concentration
// ---------------------------------------------------------------------------------------------------------------------------------

export type CustomerShare = { customer: string; value: number; share: number };
export type Concentration = { rows: CustomerShare[]; total: number; topCustomer: string | null; topShare: number | null };

/**
 * Invoiced ex VAT per customer over [start, end) (London dates), less that customer's issued credit notes in the same window. Every
 * customer with a positive total is in the denominator and in `rows` (biggest first); a customer whose credits outweigh their invoices
 * is left out of the rows but their negative total still counts in the total (credit is real). `topShare` is the largest customer's
 * whole percent of the total, null when the total is not above zero. null when an invoice in the window has no figures.
 */
export function customerConcentration(invoices: NumberInvoice[], credits: NumberCredit[], window: { start: string; end: string }): Concentration | null {
  const byCustomer = new Map<string, number>();
  for (const row of invoices) {
    if (!isInvoiced(row)) continue;
    const day = invoiceDay(row);
    if (day < window.start || day >= window.end) continue;
    const net = invoiceNetPence(row);
    if (net === null) return null;
    const name = customerOf(row.customer);
    byCustomer.set(name, (byCustomer.get(name) ?? 0) + net);
  }
  for (const credit of credits) {
    if (!isIssuedCredit(credit)) continue;
    const day = calendarDate(credit.credit_date);
    if (day < window.start || day >= window.end) continue;
    const name = customerOf(credit.customer);
    byCustomer.set(name, (byCustomer.get(name) ?? 0) - creditNetPence(credit));
  }
  const total = [...byCustomer.values()].reduce((sum, v) => sum + v, 0);
  const ranked = [...byCustomer].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows = ranked.map(([customer, value]) => ({ customer, value: fromPence(value), share: total > 0 ? Math.round((value / total) * 100) : 0 }));
  return { rows, total: fromPence(total), topCustomer: rows[0]?.customer ?? null, topShare: total > 0 && rows[0] ? rows[0].share : null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Machine time
// ---------------------------------------------------------------------------------------------------------------------------------

/** Merged length, in ms, of intervals (overlaps counted once). */
function mergedMs(ranges: Array<[number, number]>): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const [start, end] of sorted) {
    if (!current) current = [start, end];
    else if (start <= current[1]) current[1] = Math.max(current[1], end);
    else {
      total += current[1] - current[0];
      current = [start, end];
    }
  }
  return current ? total + current[1] - current[0] : total;
}

const hoursOf = (ms: number) => Math.round((ms / HOUR_MS) * 100) / 100;

export type MachineHours = { id: string; machine: string; hours: number };

/**
 * Recorded cutting hours per machine between two instants (the London midnights of the chosen window), clipped to it; a run still going
 * ends at `now`. Overlapping runs on one machine count once; a paused run has ended, so paused time is never counted. A run on a machine
 * that is no longer listed is kept under "Removed machine", never dropped. Machines with no run show 0 h (the read worked).
 */
export function machineHours(runs: NumberRun[], machines: NumberMachine[], window: { startAt: string; endAt: string }, now: Date): MachineHours[] {
  const lo = Date.parse(window.startAt);
  const hi = Math.min(Date.parse(window.endAt), now.getTime());
  const ranges = new Map<string, Array<[number, number]>>();
  for (const run of runs) {
    const start = Math.max(Date.parse(run.started_at), lo);
    const end = Math.min(run.ended_at ? Date.parse(run.ended_at) : hi, hi);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    ranges.set(run.machine_id, [...(ranges.get(run.machine_id) ?? []), [start, end]]);
  }
  const known = new Set(machines.map((m) => m.id));
  const rows: MachineHours[] = machines.map((m) => ({ id: m.id, machine: m.name, hours: hoursOf(mergedMs(ranges.get(m.id) ?? [])) }));
  const removed = [...ranges].filter(([id]) => !known.has(id)).reduce((sum, [, list]) => sum + mergedMs(list), 0);
  if (removed > 0) rows.push({ id: "removed", machine: "Removed machine", hours: hoursOf(removed) });
  return rows.sort((a, b) => b.hours - a.hours || a.machine.localeCompare(b.machine));
}
