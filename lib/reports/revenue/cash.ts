/**
 * Revenue, basis 2: CASH RECEIVED. Pure: rows in, figures out.
 *
 * Inputs: invoice_payments rows (amount, paid_on) and a date range (London dates, both ends included). Output: money received per London
 * month by the date paid, reversals (negative rows) included on their own date, and their sum. Worked out by receivedByMonth
 * (lib/numbers), so it agrees with the Numbers page. Payments carry no customer, so cash is not split or filtered by customer.
 * Must not change: no figure here may be added to invoiced or pipeline.
 */
import { calendarDate } from "@/lib/dates";
import { fromPence, toPence } from "@/lib/money";
import { receivedByMonth, type NumberPayment } from "@/lib/numbers";
import { inRange, periodsForRange, type RevenueRange } from "@/lib/reports/revenue/invoiced";

export type CashMonth = { key: string; label: string; received: number };
export type CashResult = { months: CashMonth[]; receivedTotal: number };

export function cashRevenue(payments: NumberPayment[], range: RevenueRange): CashResult {
  const periods = periodsForRange(range);
  const byMonth = receivedByMonth(payments.filter((p) => inRange(calendarDate(p.paid_on), range)), periods);
  const months = periods.map((p) => ({ key: p.key, label: p.label, received: byMonth.get(p.key) ?? 0 }));
  return { months, receivedTotal: fromPence(months.reduce((sum, m) => sum + toPence(m.received), 0)) };
}
