/**
 * E6 (migration 132): the dashboard's quote and money tiles worked out in the database must be the SAME figures the page worked out
 * from every row, to the last bit, and the same text on screen. tests/fixtures/dashboard-tiles-132.json holds, for five signed-in people
 * on one seed, the rows the old reads fetch and 132's six answers (made on PostgreSQL 16 by
 * tests/scripts/sql/132_dashboard_tile_figures.fixture.sql; hand counts and row-level security in 132_dashboard_tile_figures.proof.sql).
 * Both sides go through the app's own code here. The one figure that is not the same to the last bit is the money-owed total: the old
 * page added pounds as floats (634.3200000000002), 132 returns exact whole pence (63432 -> 634.32). It must be within half a penny of
 * the old float, the same pence, and the same text on screen (whole pounds), for every person; Delta is the one seeded case where the
 * old float sum (3.4999999999999996) showed a pound less than the exact 3.50 rounds to: £3 then, £4 now.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadMoneyTiles, loadQuoteTiles, moneyTilesFromAggregate, moneyTilesFromRows, quoteTilesFromAggregates, quoteTilesFromRows,
  type TileClient,
} from "@/lib/dashboard-tile-figures";
import { lights } from "@/lib/dashboard-analytics";
import { gbp } from "@/lib/money";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fixture = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/dashboard-tiles-132.json"), "utf8"));
const dates = fixture.dates as { today: string; monthStart: string; ninetyDaysAgo: string };
const people = Object.entries(fixture.people as Record<string, { rows: Record<string, any[]>; rpc: Record<string, any> }>);
const aggregates = (rpc: Record<string, any>) => ({ open: rpc.open, sent: rpc.sent, won: rpc.won, outcomes: rpc.outcomes, rfqs: rpc.rfqs });
/** The page's overdue sum (dashboard page.tsx: every bucket but "not due"). */
const overdue = (m: ReturnType<typeof moneyTilesFromRows>) => (m.owedByAge ? m.owedByAge.filter((b) => b.key !== "not_due").reduce((sum, b) => sum + b.value, 0) : null);
/** What the tiles print (the page's num/money and gbp helpers, the Money owed light), so "the same" also means the same text on screen. */
const shown = (t: ReturnType<typeof quoteTilesFromRows>, m: ReturnType<typeof moneyTilesFromRows>) => ({
  openQuotes: t.openQuotes, pipeline: t.pipelineValue === null ? null : gbp(t.pipelineValue, 0), rfqs: t.rfqsToQuote, sent: t.quotesSentThisMonth,
  won: JSON.stringify(t.quotesWon), quotes90: JSON.stringify(t.quotes90), invoices: m.unpaidInvoices,
  moneyOwed: m.moneyOwed === null ? null : gbp(m.moneyOwed, 0), toConfirm: m.toConfirm, byAge: JSON.stringify(m.owedByAge?.map((b) => gbp(b.value, 0))),
  overdue: overdue(m) === null ? null : gbp(overdue(m)!, 0), light: lights.moneyOwed(m.moneyOwed, overdue(m)),
});
/** Where the old float total's text differed from the exact total's: only Delta (exactly 3.50, old float sum 3.4999999999999996). */
const OLD_FLOAT_SHOWED: Record<string, { old: string; now: string }> = { delta_admin: { old: "£3", now: "£4" } };

describe("132 parity: the database's answers give exactly the old figures", () => {
  it("the fixture covers five people and the awkward rows", () => {
    expect(people.map(([who]) => who).sort()).toEqual(["alpha_admin", "alpha_office_quotes_hidden", "beta_admin", "delta_admin", "gamma_admin"]);
    expect(fixture.people.alpha_admin.rows.quotes.length).toBe(20);
    expect(fixture.people.alpha_admin.rows.unpaid.length).toBe(58);
    expect(fixture.people.gamma_admin.rows.unpaid.length).toBe(203);
    expect(fixture.people.delta_admin.rows.unpaid.length).toBe(3);
  });

  it("every answer is whole numbers only (counts and pence: no float, whose JSON text depends on extra_float_digits)", () => {
    for (const [who, { rpc }] of people) {
      for (const [fn, answer] of Object.entries(rpc)) {
        for (const [key, value] of Object.entries(answer as Record<string, unknown>)) expect(Number.isSafeInteger(value), `${who} ${fn}.${key}`).toBe(true);
      }
      expect(Object.keys(rpc.owed).sort(), who).toEqual(["invoices", "late_1_30", "late_31_60", "late_60_plus", "not_due", "owed_pence", "to_confirm"]);
    }
  });

  it("no half pence: every amount the old reads add has at most two decimals", () => {
    for (const [who, { rows }] of people) {
      for (const row of rows.unpaid) {
        for (const key of ["total", "amount_paid", "credited_amount", "refunded_amount"]) {
          const v = Number(row[key] ?? 0);
          expect(Math.abs(Math.round(v * 100) - v * 100), `${who} ${row.invoice_ref} ${key}`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("the money-owed edge cases are real: the old float totals drift off the exact pence (alpha, gamma, delta)", () => {
    const old = (who: string) => moneyTilesFromRows(fixture.people[who].rows.unpaid, dates.today).moneyOwed;
    const now = (who: string) => moneyTilesFromAggregate(fixture.people[who].rpc.owed).moneyOwed;
    expect([old("alpha_admin"), now("alpha_admin")]).toEqual([634.3200000000002, 634.32]);
    expect(old("gamma_admin")).not.toBe(now("gamma_admin"));
    expect(now("gamma_admin")).toBe(94.07);
    expect([old("delta_admin"), now("delta_admin")]).toEqual([3.4999999999999996, 3.5]);
    // over-paid, over-credited: 0 (never below zero); refunded after paying: 4.00; part-paid: 66.67 (Gamma, 9407 pence in all)
    const g = fixture.people.gamma_admin.rows.unpaid;
    expect(["INV-GO", "INV-GC", "INV-GR", "INV-GP"].map((ref) => moneyTilesFromRows(g.filter((r: any) => r.invoice_ref === ref), dates.today).moneyOwed)).toEqual([0, 0, 4, 66.67]);
  });

  for (const [who, { rows, rpc }] of people) {
    it(`${who}: quote tiles identical (open, value, accepted, RFQs, sent, won, 90 days)`, () => {
      const before = quoteTilesFromRows(rows.quotes, rows.declined, rows.rfqs, dates);
      const after = quoteTilesFromAggregates(aggregates(rpc));
      expect(after).toStrictEqual(before);
      expect(Object.is(after.pipelineValue, before.pipelineValue)).toBe(true);
    });
    it(`${who}: money tiles identical (invoices, to confirm, by age to the last bit; owed the exact pence of the old float total)`, () => {
      const before = moneyTilesFromRows(rows.unpaid, dates.today);
      const after = moneyTilesFromAggregate(rpc.owed);
      expect({ ...after, moneyOwed: 0 }).toStrictEqual({ ...before, moneyOwed: 0 });
      after.owedByAge!.forEach((b, i) => expect(Object.is(b.value, before.owedByAge![i].value)).toBe(true));
      expect(after.moneyOwed).toBe(rpc.owed.owed_pence / 100);
      expect(Math.round(before.moneyOwed! * 100)).toBe(rpc.owed.owed_pence);
      expect(Math.abs(before.moneyOwed! - after.moneyOwed!)).toBeLessThan(0.005);
    });
    it(`${who}: the same text on every tile${OLD_FLOAT_SHOWED[who] ? " (Money owed: the exact total's rounding, where the old float fell below 50p)" : ""}`, () => {
      const now = shown(quoteTilesFromAggregates(aggregates(rpc)), moneyTilesFromAggregate(rpc.owed));
      const old = shown(quoteTilesFromRows(rows.quotes, rows.declined, rows.rfqs, dates), moneyTilesFromRows(rows.unpaid, dates.today));
      const differs = OLD_FLOAT_SHOWED[who];
      if (differs) {
        expect([old.moneyOwed, now.moneyOwed]).toEqual([differs.old, differs.now]);
        expect(now.moneyOwed).toBe(gbp(rpc.owed.owed_pence / 100, 0));
        expect({ ...now, moneyOwed: null }).toEqual({ ...old, moneyOwed: null });
      } else {
        expect(now).toEqual(old);
      }
    });
  }

  it("alpha admin against the hand count (seed comments)", () => {
    const { rows, rpc } = fixture.people.alpha_admin;
    const t = quoteTilesFromAggregates(aggregates(rpc));
    expect(t).toMatchObject({ openQuotes: 6, pipelineValue: 1235128.19, acceptedQuotes: 3, rfqsToQuote: 4, quotesSentThisMonth: 8, quotesWon: { count: 2, undated: 1 } });
    expect(t.quotes90).toEqual({ outcomes: [
      { key: "accepted", label: "Accepted", count: 2 }, { key: "sent", label: "Awaiting reply", count: 6 },
      { key: "expired", label: "Expired", count: 1 }, { key: "rejected", label: "Rejected", count: 1 }], winRate: 50 });
    const m = moneyTilesFromAggregate(rpc.owed);
    // Exact whole pence (63432); the old page's float sum in id order was 634.3200000000002. £634 on screen either way.
    expect(rpc.owed.owed_pence).toBe(63432);
    expect(m.moneyOwed).toBe(634.32);
    expect(moneyTilesFromRows(rows.unpaid, dates.today).moneyOwed).toBe(634.3200000000002);
    expect(gbp(m.moneyOwed!, 0)).toBe(gbp(moneyTilesFromRows(rows.unpaid, dates.today).moneyOwed!, 0));
    expect(m).toMatchObject({ unpaidInvoices: 49, toConfirm: 2 });
    expect(m.owedByAge!.map((b) => b.value)).toEqual([197.87, 153.05, 143.4, 140]);
  });
});

describe("132 money on screen: whole pence in, the page's own gbp(value, 0) out", () => {
  const answer = (pence: number) => ({ to_confirm: 0, invoices: 1, owed_pence: pence, not_due: pence, late_1_30: pence, late_31_60: pence, late_60_plus: pence });
  /** The headline (KPI card money() and the panel's meta: gbp(value, 0)) and each bucket row (gbp(b.value, 0)), as the page renders them. */
  const rendered = (pence: number) => {
    const m = moneyTilesFromAggregate(answer(pence));
    return [gbp(m.moneyOwed!, 0), ...m.owedByAge!.map((b) => gbp(b.value, 0))];
  };

  it("349p -> £3, 350p -> £4, 351p -> £4 (Intl's half-expand: half a pound rounds up), headline and every bucket alike", () => {
    expect(rendered(349)).toEqual(Array(5).fill("£3"));
    expect(rendered(350)).toEqual(Array(5).fill("£4"));
    expect(rendered(351)).toEqual(Array(5).fill("£4"));
  });

  it("negatives (never sent: every invoice's balance is at least 0, buckets only count pence > 0) would round away from zero: -£3, -£4, -£4", () => {
    // The page formats with gbp (Intl.NumberFormat, half-expand), never Math.round (which gives -3 for -3.5): headline and buckets alike.
    expect(Math.round(-3.5)).toBe(-3);
    expect(rendered(-349)).toEqual(Array(5).fill("-£3"));
    expect(rendered(-350)).toEqual(Array(5).fill("-£4"));
    expect(rendered(-351)).toEqual(Array(5).fill("-£4"));
    for (const [who, { rpc }] of people) for (const [key, v] of Object.entries(rpc.owed)) expect(v as number, `${who} ${key}`).toBeGreaterThanOrEqual(0);
  });

  it("the headline and every bucket are the database's whole pence / 100, nothing added up in the browser", () => {
    // Deliberately inconsistent pence: if the headline or a bucket were summed from anything else, it would not be exactly its own field.
    const m = moneyTilesFromAggregate({ to_confirm: 0, invoices: 3, owed_pence: 63432, not_due: 1, late_1_30: 29, late_31_60: 7, late_60_plus: 10 });
    expect(m.moneyOwed).toBe(634.32);
    expect(m.owedByAge!.map((b) => b.value)).toEqual([0.01, 0.29, 0.07, 0.1]);
    for (const [who, { rpc }] of people) {
      const t = moneyTilesFromAggregate(rpc.owed);
      expect(Object.is(t.moneyOwed, rpc.owed.owed_pence / 100), who).toBe(true);
      for (const b of t.owedByAge!) {
        expect(Number.isSafeInteger(rpc.owed[b.key]), `${who} ${b.key}`).toBe(true);
        expect(Object.is(b.value, rpc.owed[b.key] / 100), `${who} ${b.key}`).toBe(true);
      }
    }
  });
});

/** A fake client: rpc answers from `answers` (or the given error); from() pages over the fixture rows like PostgREST with order+range. */
function fakeClient(rows: Record<string, any[]>, answers: Record<string, any>, rpcError?: (fn: string) => { code: string; message: string } | null) {
  const calls: string[] = [];
  const client: TileClient = {
    rpc: async (fn) => {
      calls.push(`rpc:${fn}`);
      const error = rpcError?.(fn) ?? null;
      return error ? { data: null, error } : { data: answers[fn], error: null };
    },
    from: (table: string) => {
      const source = table === "quotes" ? rows.quotes : table === "quote_line_items" ? rows.declined : table === "rfqs" ? rows.rfqs : rows.unpaid;
      const chain: any = {
        select: () => chain, order: () => chain, eq: () => chain, neq: () => chain,
        range: async (from: number, to: number) => { calls.push(`read:${table}`); return { data: source.slice(from, to + 1), error: null }; },
      };
      return chain;
    },
  };
  return { client, calls };
}
const rpcAnswers = (rpc: Record<string, any>) => ({
  dashboard_open_quotes: rpc.open, dashboard_quotes_sent: rpc.sent, dashboard_quotes_won: rpc.won,
  dashboard_quote_outcomes: rpc.outcomes, dashboard_rfqs_to_quote: rpc.rfqs, dashboard_money_owed: rpc.owed,
});

describe("132 loaders: one call per tile, the old reads while 132 is missing", () => {
  const { rows, rpc } = fixture.people.alpha_admin;
  const has068 = async () => true;

  it("132 applied: five quote calls and one money call, no rows read", async () => {
    const { client, calls } = fakeClient(rows, rpcAnswers(rpc));
    const quotes = await loadQuoteTiles(client, dates, has068);
    const money = await loadMoneyTiles(client, dates.today);
    expect(calls.filter((c) => c.startsWith("read:"))).toEqual([]);
    expect(calls.sort()).toEqual(["rpc:dashboard_money_owed", "rpc:dashboard_open_quotes", "rpc:dashboard_quote_outcomes", "rpc:dashboard_quotes_sent", "rpc:dashboard_quotes_won", "rpc:dashboard_rfqs_to_quote"]);
    expect(quotes).toStrictEqual(quoteTilesFromRows(rows.quotes, rows.declined, rows.rfqs, dates));
    expect(money).toStrictEqual(moneyTilesFromAggregate(rpc.owed));
    expect(shown(quotes, money)).toEqual(shown(quotes, moneyTilesFromRows(rows.unpaid, dates.today)));
  });

  it("132 not applied (function missing): the old reads, same figures", async () => {
    const missing = () => ({ code: "PGRST202", message: "Could not find the function public.dashboard_open_quotes in the schema cache" });
    const { client, calls } = fakeClient(rows, {}, missing);
    const quotes = await loadQuoteTiles(client, dates, has068);
    const money = await loadMoneyTiles(client, dates.today);
    expect(calls).toEqual(expect.arrayContaining(["read:quotes", "read:quote_line_items", "read:rfqs", "read:invoices"]));
    expect(quotes).toStrictEqual(quoteTilesFromAggregates(aggregates(rpc)));
    expect(money).toStrictEqual(moneyTilesFromRows(rows.unpaid, dates.today));
    expect(shown(quotes, money)).toEqual(shown(quotes, moneyTilesFromAggregate(rpc.owed)));
  });

  it("another failure blanks only that tile (a dash), never falls back or fakes a number", async () => {
    const { client, calls } = fakeClient(rows, rpcAnswers(rpc), (fn) => (fn === "dashboard_quotes_won" || fn === "dashboard_money_owed" ? { code: "57014", message: "canceling statement due to statement timeout" } : null));
    const quotes = await loadQuoteTiles(client, dates, has068);
    const money = await loadMoneyTiles(client, dates.today);
    expect(calls.filter((c) => c.startsWith("read:"))).toEqual([]);
    expect(quotes.quotesWon).toBeNull();
    expect(quotes.openQuotes).toBe(6);
    expect(money).toEqual({ failed: true, toConfirm: null, unpaidInvoices: null, moneyOwed: null, owedByAge: null });
  });
});
