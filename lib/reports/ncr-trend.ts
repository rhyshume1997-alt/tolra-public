/**
 * NCR trend by London month, from the per-month counts Jobs already makes (ncrByMonth). Per month: confirmed NCRs (and how many by type),
 * quantity scrapped, and the failed inspections with no linked rework ("not linked", shown apart and never in the confirmed count). There is
 * NO cost here: rework hours and material cost are not read or shown.
 *
 * Inputs: the Map from ncrByMonth and the London months. Outputs: one row per month (every month present, zeros included) and a total.
 * Must not change: not-linked stays out of the confirmed counts. Pure (no React, no I/O).
 */
import { NCR_CONFIRMED_TYPES, type NcrMonth } from "@/lib/jobs/ncr-register";
import type { Period } from "@/lib/numbers";

export type NcrTrendMonth = { key: string; label: string; confirmed: number; byType: Record<string, number>; scrapped: number; notLinked: number };
export type NcrTrendReport = { months: NcrTrendMonth[]; total: Omit<NcrTrendMonth, "key" | "label"> };

export function ncrTrend(byMonth: ReadonlyMap<string, NcrMonth>, periods: Period[]): NcrTrendReport {
  const zeroTypes = () => Object.fromEntries(NCR_CONFIRMED_TYPES.map((t) => [t, 0])) as Record<string, number>;
  const total = { confirmed: 0, byType: zeroTypes(), scrapped: 0, notLinked: 0 };
  const months = periods.map<NcrTrendMonth>((p) => {
    const m = byMonth.get(p.key);
    const byType = zeroTypes();
    for (const t of NCR_CONFIRMED_TYPES) { byType[t] = m?.byType[t] ?? 0; total.byType[t] += byType[t]; }
    const row = { key: p.key, label: p.label, confirmed: m?.confirmed ?? 0, byType, scrapped: m?.scrapped ?? 0, notLinked: m?.notLinked ?? 0 };
    total.confirmed += row.confirmed; total.scrapped += row.scrapped; total.notLinked += row.notLinked;
    return row;
  });
  return { months, total };
}
