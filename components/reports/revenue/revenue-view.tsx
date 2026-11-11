"use client";

/**
 * The Revenue report (Reporting, stage 1), read-only. Holds the two filters (date range and customer) in React state ONLY: not in the
 * address, not in storage, nothing saved. OFF by default (lib/reports/revenue/revenue-switch): off, it says so and reads nothing.
 * Two bases, never added together: invoiced (ex VAT, less credit notes) and cash received; the pipeline is a third, separate section.
 * Inputs: the company's settings (the switch), the person's role, the chosen filters. Output: the cards. Reads go through
 * lib/reports/revenue/load-revenue (SELECT only, under the person's own session).
 * Must not change: no combined total of invoiced, cash and pipeline anywhere; no write; no saved filters.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { CashCard } from "@/components/reports/revenue/cash-card";
import { CustomerTable } from "@/components/reports/revenue/customer-table";
import { InvoicedCard } from "@/components/reports/revenue/invoiced-card";
import { PartTable } from "@/components/reports/revenue/part-table";
import { PipelineCard } from "@/components/reports/revenue/pipeline-card";
import { calendarDate, toDateInput } from "@/lib/dates";
import { useOrgSettings } from "@/lib/org-settings";
import { invoicedByPart } from "@/lib/reports/revenue/by-part";
import { invoicedByCustomer } from "@/lib/reports/revenue/by-customer";
import { cashRevenue } from "@/lib/reports/revenue/cash";
import { creditsInScope, customerName, invoicesInScope, invoicedRevenue, type RevenueRange } from "@/lib/reports/revenue/invoiced";
import { isInvoiced, londonMonthsEnding } from "@/lib/numbers";
import { loadRevenue, type Read, type RevenueData } from "@/lib/reports/revenue/load-revenue";
import { pipelineQuotes } from "@/lib/reports/revenue/pipeline";
import { canSeeRevenue, REVENUE_OFF_NOTICE, revenueEnabled } from "@/lib/reports/revenue/revenue-switch";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const MAX_MONTHS = 60;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const rowsOf = <T,>(read: Read<T>): T[] | null => ("rows" in read ? read.rows : null);
const cut = (read: Read<unknown>) => "rows" in read && read.truncated;

function defaultRange(): RevenueRange {
  return { from: londonMonthsEnding(new Date(), 12)[0].start, to: toDateInput(new Date()) };
}

/** The problem with a chosen range, or null when it can be read. */
function rangeProblem({ from, to }: RevenueRange): string | null {
  if (!DATE.test(from) || !DATE.test(to)) return "Choose a start and an end date.";
  if (from > to) return "The start date is after the end date.";
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1 > MAX_MONTHS ? `Choose ${MAX_MONTHS} months or fewer.` : null;
}

export function RevenueView() {
  const { hiddenNav, loaded } = useOrgSettings();
  const { activeRole, loading: userLoading } = useUser();
  const on = loaded && !userLoading && revenueEnabled(hiddenNav) && canSeeRevenue(activeRole);
  const [range, setRange] = useState<RevenueRange>(defaultRange);
  const [customer, setCustomer] = useState("");
  const [data, setData] = useState<RevenueData | null>(null);
  const [today, setToday] = useState(() => toDateInput(new Date()));
  const latest = useRef(0);
  const problem = rangeProblem(range);

  useEffect(() => {
    if (!on || problem) return;
    const ticket = ++latest.current;
    setData(null);
    void loadRevenue(supabase, range).then((result) => {
      if (latest.current !== ticket) return;
      setToday(toDateInput(new Date()));
      setData(result);
    });
  }, [on, problem, range]);

  const view = useMemo(() => {
    if (!data || problem) return null;
    const who = customer || null;
    const invoices = rowsOf(data.invoices);
    const credits = rowsOf(data.credits);
    const payments = rowsOf(data.payments);
    const lines = rowsOf(data.invoiceLines);
    const orderLines = rowsOf(data.orderLines);
    const quotes = rowsOf(data.quotes);
    const quoteLines = rowsOf(data.quoteLines);
    const names = new Set<string>();
    if (invoices) for (const row of invoicesInScope(invoices, range, null)) if (isInvoiced(row)) names.add(customerName(row.customer));
    if (credits) for (const row of creditsInScope(credits, range, null)) names.add(customerName(row.customer));
    if (quotes) for (const row of quotes) if (calendarDate(row.sent_at) >= range.from && calendarDate(row.sent_at) <= range.to) names.add(customerName(row.customer));
    return {
      names: [...names].sort((a, b) => a.localeCompare(b)),
      invoiced: invoices && credits ? invoicedRevenue(invoices, credits, range, who) : null,
      cash: payments ? cashRevenue(payments, range) : null,
      customers: invoices && credits ? invoicedByCustomer(invoices, credits, range, who) : null,
      parts: invoices && credits && lines && orderLines ? invoicedByPart(invoices, lines, orderLines, credits, range, who) : null,
      pipeline: quotes && quoteLines ? pipelineQuotes(quotes, quoteLines, today, range, who) : null,
    };
  }, [data, range, customer, today, problem]);

  if (userLoading || !loaded) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (!on) {
    return (
      <div className="min-w-0 space-y-2" data-testid="revenue-off">
        <h1 className="page-title">Revenue</h1>
        <p className="text-sm text-muted-foreground">{REVENUE_OFF_NOTICE}</p>
      </div>
    );
  }

  const names = view?.names ?? [];
  const incomplete = (...reads: Array<Read<unknown> | undefined>) => reads.some((read) => (read ? cut(read) : false));

  return (
    <div className="min-w-0 space-y-6" data-testid="revenue-page">
      <header className="space-y-3">
        <div>
          <h1 className="page-title">Revenue</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Read-only. Invoiced revenue and cash received are two separate measures and are never added together. Months follow the UK calendar.
            Customers are matched by the name on the invoice.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            From
            <input type="date" aria-label="From date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} className="h-9 border border-line bg-surface px-3 text-sm font-normal text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            To
            <input type="date" aria-label="To date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} className="h-9 border border-line bg-surface px-3 text-sm font-normal text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            Customer
            <select aria-label="Customer" value={customer} onChange={(event) => setCustomer(event.target.value)} className="h-9 border border-line bg-surface px-3 text-sm font-normal text-ink">
              <option value="">All customers</option>
              {customer && !names.includes(customer) ? <option value={customer}>{customer}</option> : null}
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        </div>
        {problem ? <p className="text-sm text-ink" role="alert">{problem}</p> : null}
      </header>

      {!view ? (
        problem ? null : <p className="text-sm text-muted-foreground" role="status">Loading revenue…</p>
      ) : (
        <>
          <InvoicedCard result={view.invoiced} failed={!view.invoiced} incomplete={incomplete(data?.invoices, data?.credits)} />
          <CashCard result={view.cash} failed={!view.cash} incomplete={incomplete(data?.payments)} customerFiltered={Boolean(customer)} />
          <CustomerTable result={view.customers} failed={!view.customers} incomplete={incomplete(data?.invoices, data?.credits)} />
          <PartTable result={view.parts} failed={!view.parts} incomplete={incomplete(data?.invoices, data?.credits, data?.invoiceLines, data?.orderLines)} />
          <PipelineCard result={view.pipeline} failed={!view.pipeline} incomplete={incomplete(data?.quotes, data?.quoteLines)} />
        </>
      )}
    </div>
  );
}
