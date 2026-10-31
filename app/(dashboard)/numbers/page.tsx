"use client";

/**
 * Numbers (admin only): three history questions the Overview does not answer. The calculations are lib/numbers; this page only reads
 * the rows and shows them. Each question reads its own tables, so one failed read costs that panel only, and a failed read is a dash
 * with "Couldn't load this." and a Retry, never 0. The rows are filtered in the database to the chosen London months and loaded page
 * by page (lib/fetch-all); the page never uses the service role, so the signed-in admin's company and RLS decide what comes back.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BarList, Panel } from "@/components/dashboard-charts";
import { CashBars } from "@/components/numbers-charts";
import { StatTile } from "@/components/stat-tile";
import { fetchAll } from "@/lib/fetch-all";
import { gbp } from "@/lib/money";
import {
  cashByMonth,
  customerConcentration,
  invoicedByMonth,
  londonMonthsEnding,
  machineHours,
  receivedByMonth,
  sumOrNull,
  windowOf,
  type NumberCredit,
  type NumberInvoice,
  type NumberMachine,
  type NumberPayment,
  type NumberRun,
} from "@/lib/numbers";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const FAILED = "Couldn't load this.";
const MONTH_CHOICES = [3, 6, 12] as const;
const SHOWN_CUSTOMERS = 8;

type Read<T> = { rows: T[] } | { failed: true };
type Loaded = {
  now: Date;
  invoices: Read<NumberInvoice>;
  credits: Read<NumberCredit>;
  payments: Read<NumberPayment>;
  machines: Read<NumberMachine>;
  runs: Read<NumberRun>;
};

const iso = (ms: string) => ms.replace(".000Z", "Z");

/** One list, every row of it (page by page); a failed or cut-short read is a failure, never a smaller list. */
async function readAll<T extends Record<string, unknown>>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<Read<T>> {
  try {
    const { rows, truncated } = await fetchAll<T>(page);
    return truncated ? { failed: true } : { rows };
  } catch {
    return { failed: true };
  }
}

async function loadNumbers(months: number): Promise<Loaded> {
  const db = supabase;
  const now = new Date();
  if (!db) {
    const failed = { failed: true } as const;
    return { now, invoices: failed, credits: failed, payments: failed, machines: failed, runs: failed };
  }
  const w = windowOf(londonMonthsEnding(now, months));
  const startAt = iso(w.startAt);
  const endAt = iso(w.endAt);
  const [invoices, credits, payments, machines, runs] = await Promise.all([
    // An invoice counts on its invoice date, else the day it was made (London): the window is applied to whichever it has.
    readAll<NumberInvoice & Record<string, unknown>>((from, to) => db.from("invoices").select("id, customer, status, subtotal, vat, carriage, total, invoice_date, created_at")
      .or(`invoice_date.gte.${w.start},and(invoice_date.is.null,created_at.gte.${startAt})`)
      .or(`invoice_date.lt.${w.end},and(invoice_date.is.null,created_at.lt.${endAt})`)
      .order("id").range(from, to)),
    readAll<NumberCredit & Record<string, unknown>>((from, to) => db.from("credit_notes").select("id, customer, status, vat, total, credit_date").eq("status", "issued").gte("credit_date", w.start).lt("credit_date", w.end).order("id").range(from, to)),
    readAll<NumberPayment & Record<string, unknown>>((from, to) => db.from("invoice_payments").select("id, amount, paid_on").gte("paid_on", w.start).lt("paid_on", w.end).order("id").range(from, to)),
    readAll<NumberMachine & Record<string, unknown>>((from, to) => db.from("machines").select("id, name").order("id").range(from, to)),
    // Runs that touch the window: started before it ends, and either still going or ended after it starts.
    readAll<NumberRun & Record<string, unknown>>((from, to) => db.from("machine_runs").select("id, machine_id, started_at, ended_at")
      .lt("started_at", endAt).or(`ended_at.is.null,ended_at.gt.${startAt}`).order("id").range(from, to)),
  ]);
  return { now, invoices, credits, payments, machines, runs };
}

const rowsOf = <T,>(read: Read<T>): T[] | null => ("rows" in read ? read.rows : null);

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-4 text-sm text-ink" data-testid="numbers-failed">
      <span className="font-semibold tabular-nums">—</span> {FAILED}
      <button type="button" onClick={onRetry} className="font-semibold text-brand-accent hover:underline">Retry</button>
    </p>
  );
}

export default function NumbersPage() {
  const router = useRouter();
  const { activeRole, loading: userLoading } = useUser();
  const admin = !userLoading && activeRole === "admin";
  const [months, setMonths] = useState<number>(6);
  const [data, setData] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // The middleware already turns a real non-admin away; this covers an admin working in another role's view.
  useEffect(() => {
    if (!userLoading && activeRole !== "admin") router.replace("/dashboard");
  }, [userLoading, activeRole, router]);

  useEffect(() => {
    if (!admin) return;
    const ticket = ++latest.current;
    setData(null);
    void loadNumbers(months).then((result) => {
      if (latest.current === ticket) setData(result);
    });
  }, [admin, months, attempt]);

  const periods = useMemo(() => londonMonthsEnding(data?.now ?? new Date(), months), [data?.now, months]);
  const view = useMemo(() => {
    if (!data) return null;
    const invoices = rowsOf(data.invoices);
    const credits = rowsOf(data.credits);
    const payments = rowsOf(data.payments);
    const machines = rowsOf(data.machines);
    const runs = rowsOf(data.runs);
    const w = windowOf(periods);
    const invoiced = invoices && credits ? invoicedByMonth(invoices, credits, periods) : null;
    const received = payments ? receivedByMonth(payments, periods) : null;
    const cash = cashByMonth(periods, invoiced, received);
    return {
      cash,
      invoicedTotal: invoiced ? sumOrNull(cash.map((m) => m.invoiced)) : null,
      receivedTotal: received ? sumOrNull(cash.map((m) => m.received)) : null,
      invoicedRead: Boolean(invoiced),
      receivedRead: Boolean(received),
      customers: invoices && credits ? customerConcentration(invoices, credits, w) : undefined,
      machines: machines && runs ? machineHours(runs, machines, w, data.now) : null,
    };
  }, [data, periods]);

  if (!admin) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;

  const customers = view?.customers;
  const customerRows = customers
    ? [
        ...customers.rows.slice(0, SHOWN_CUSTOMERS).map((row) => ({ key: row.customer, label: `${row.customer} · ${row.share}%`, value: row.value })),
        ...(customers.rows.length > SHOWN_CUSTOMERS
          ? [{ key: "others", label: `${customers.rows.length - SHOWN_CUSTOMERS} other customers`, value: customers.rows.slice(SHOWN_CUSTOMERS).reduce((sum, row) => sum + row.value, 0) }]
          : []),
      ]
    : [];
  const anyCash = view?.cash.some((m) => m.invoiced !== null || m.received !== null);
  const span = `Last ${months} months, ${periods[0].label} to ${periods[periods.length - 1].label}`;

  return (
    <div className="min-w-0 space-y-6" data-testid="numbers-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Numbers</h1>
          <p className="mt-2 text-sm text-muted-foreground" data-testid="numbers-span">{span}. Months follow the UK calendar.</p>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-ink">
          Months
          <select aria-label="Months to show" value={months} onChange={(event) => setMonths(Number(event.target.value))} className="h-9 border border-line bg-surface px-3 text-sm font-normal text-ink">
            {MONTH_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </header>

      {!view ? (
        <p className="text-sm text-muted-foreground" role="status">Loading Numbers…</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile label="Invoiced ex VAT" value={<span data-testid="numbers-invoiced">{view.invoicedTotal === null ? "—" : gbp(view.invoicedTotal, 0)}</span>} sub={view.invoicedTotal === null ? FAILED : "Issued invoices, less credit notes on their own date"} tone="info" />
            <StatTile label="Received" value={<span data-testid="numbers-received">{view.receivedTotal === null ? "—" : gbp(view.receivedTotal, 0)}</span>} sub={view.receivedTotal === null ? FAILED : "Payments by the date received, reversals included"} tone="neutral" />
          </div>

          <Panel title="1. Which customers are we relying on?" meta={customers && customers.topCustomer && customers.topShare !== null ? `Largest: ${customers.topCustomer}, ${customers.topShare}%` : undefined}>
            <div data-testid="numbers-customers">
              {customers === undefined ? <Failed onRetry={retry} />
                : customers === null ? <p className="py-4 text-sm text-ink" role="alert"><span className="font-semibold">—</span> Some invoices have no figures, so the shares can&apos;t be worked out yet.</p>
                  : <BarList rows={customerRows} format={(value) => gbp(value, 0)} empty="No invoiced work in these months." />}
            </div>
          </Panel>

          <Panel title="2. Are invoices turning into cash?" meta="Invoiced ex VAT against money received, by month">
            <div data-testid="numbers-cash">
              {!anyCash ? <Failed onRetry={retry} /> : (
                <>
                  <CashBars data={view.cash} />
                  <p className="mt-3 text-sm text-muted-foreground">The gap is invoiced less received in that month, not money owed: a payment can settle an invoice from an earlier month.</p>
                  <table className="mt-3 w-full table-fixed text-left text-sm tabular-nums">
                    <thead>
                      <tr className="border-b border-line text-muted-foreground">
                        <th scope="col" className="py-2 pr-2 font-semibold">Month</th>
                        <th scope="col" className="px-1 py-2 text-right font-semibold">Invoiced</th>
                        <th scope="col" className="px-1 py-2 text-right font-semibold">Received</th>
                        <th scope="col" className="py-2 pl-1 text-right font-semibold">Gap</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.cash.map((m) => (
                        <tr key={m.key} className="border-b border-line/70" data-testid={`numbers-cash-${m.key}`}>
                          <th scope="row" className="py-2 pr-2 font-normal text-ink">{m.label}</th>
                          <td className="px-1 py-2 text-right" data-col="invoiced">{m.invoiced === null ? "—" : gbp(m.invoiced, 0)}</td>
                          <td className="px-1 py-2 text-right" data-col="received">{m.received === null ? "—" : gbp(m.received, 0)}</td>
                          <td className="py-2 pl-1 text-right" data-col="gap">{m.gap === null ? "—" : gbp(m.gap, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!view.invoicedRead || !view.receivedRead ? <Failed onRetry={retry} /> : null}
                </>
              )}
            </div>
          </Panel>

          <Panel title="3. Where is machine time going?" meta="Recorded machine runs, not booked hours">
            <div data-testid="numbers-machines">
              {view.machines === null ? <Failed onRetry={retry} />
                : <BarList rows={view.machines.map((row) => ({ key: row.id, label: row.machine, value: row.hours }))} format={(value) => `${value} h`} empty="No machine time recorded in these months." />}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
