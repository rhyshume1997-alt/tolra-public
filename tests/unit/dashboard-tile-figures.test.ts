/**
 * E6 (migration 132): the dashboard's quote and money tiles worked out in the database must be the SAME figures the page worked out
 * from every row, to the last bit. tests/fixtures/dashboard-tiles-132.json holds, for three signed-in people on one seed, the rows the
 * old reads fetch and 132's six answers (made on PostgreSQL 16 by tests/scripts/sql/132_dashboard_tile_figures.fixture.sql; hand counts
 * and row-level security in 132_dashboard_tile_figures.proof.sql). Both sides go through the app's own code here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadMoneyTiles, loadQuoteTiles, moneyTilesFromAggregate, moneyTilesFromRows, quoteTilesFromAggregates, quoteTilesFromRows,
  type TileClient,
} from "@/lib/dashboard-tile-figures";
import { gbp } from "@/lib/money";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fixture = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/dashboard-tiles-132.json"), "utf8"));
const dates = fixture.dates as { today: string; monthStart: string; ninetyDaysAgo: string };
const people = Object.entries(fixture.people as Record<string, { rows: Record<string, any[]>; rpc: Record<string, any> }>);
const aggregates = (rpc: Record<string, any>) => ({ open: rpc.open, sent: rpc.sent, won: rpc.won, outcomes: rpc.outcomes, rfqs: rpc.rfqs });
/** What the tiles print (the page's num/money and gbp helpers), so "the same" also means the same text on screen. */
const shown = (t: ReturnType<typeof quoteTilesFromRows>, m: ReturnType<typeof moneyTilesFromRows>) => [
  t.openQuotes, t.pipelineValue === null ? null : gbp(t.pipelineValue, 0), t.rfqsToQuote, t.quotesSentThisMonth, JSON.stringify(t.quotesWon),
  JSON.stringify(t.quotes90), m.unpaidInvoices, m.moneyOwed === null ? null : gbp(m.moneyOwed, 0), m.toConfirm,
  JSON.stringify(m.owedByAge?.map((b) => gbp(b.value, 0))),
];

describe("132 parity: the database's answers give exactly the old figures", () => {
  it("the fixture covers three people and the awkward rows", () => {
    expect(people.map(([who]) => who).sort()).toEqual(["alpha_admin", "alpha_office_quotes_hidden", "beta_admin"]);
    expect(fixture.people.alpha_admin.rows.quotes.length).toBe(20);
    expect(fixture.people.alpha_admin.rows.unpaid.length).toBe(58);
  });

  for (const [who, { rows, rpc }] of people) {
    it(`${who}: quote tiles identical (open, value, accepted, RFQs, sent, won, 90 days)`, () => {
      const before = quoteTilesFromRows(rows.quotes, rows.declined, rows.rfqs, dates);
      const after = quoteTilesFromAggregates(aggregates(rpc));
      expect(after).toStrictEqual(before);
      expect(Object.is(after.pipelineValue, before.pipelineValue)).toBe(true);
    });
    it(`${who}: money tiles identical (owed to the last bit, invoices, to confirm, by age)`, () => {
      const before = moneyTilesFromRows(rows.unpaid, dates.today);
      const after = moneyTilesFromAggregate(rpc.owed);
      expect(after).toStrictEqual(before);
      expect(Object.is(after.moneyOwed, before.moneyOwed)).toBe(true);
      after.owedByAge!.forEach((b, i) => expect(Object.is(b.value, before.owedByAge![i].value)).toBe(true));
    });
    it(`${who}: the same text on every tile`, () => {
      expect(shown(quoteTilesFromAggregates(aggregates(rpc)), moneyTilesFromAggregate(rpc.owed)))
        .toEqual(shown(quoteTilesFromRows(rows.quotes, rows.declined, rows.rfqs, dates), moneyTilesFromRows(rows.unpaid, dates.today)));
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
    // The pounds added one invoice at a time in id order, as the page did: not the exact 634.32.
    expect(m.moneyOwed).toBe(634.3200000000002);
    expect(moneyTilesFromRows(rows.unpaid, dates.today).moneyOwed).toBe(634.3200000000002);
    expect(m).toMatchObject({ unpaidInvoices: 49, toConfirm: 2 });
    expect(m.owedByAge!.map((b) => b.value)).toEqual([197.87, 153.05, 143.4, 140]);
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
    expect(money).toStrictEqual(moneyTilesFromRows(rows.unpaid, dates.today));
  });

  it("132 not applied (function missing): the old reads, same figures", async () => {
    const missing = () => ({ code: "PGRST202", message: "Could not find the function public.dashboard_open_quotes in the schema cache" });
    const { client, calls } = fakeClient(rows, {}, missing);
    const quotes = await loadQuoteTiles(client, dates, has068);
    const money = await loadMoneyTiles(client, dates.today);
    expect(calls).toEqual(expect.arrayContaining(["read:quotes", "read:quote_line_items", "read:rfqs", "read:invoices"]));
    expect(quotes).toStrictEqual(quoteTilesFromAggregates(aggregates(rpc)));
    expect(money).toStrictEqual(moneyTilesFromAggregate(rpc.owed));
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
