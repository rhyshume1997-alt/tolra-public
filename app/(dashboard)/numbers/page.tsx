"use client";

/**
 * Numbers (admin only): three history questions the Overview does not answer. The calculations are lib/numbers; this page only reads
 * the rows and shows them. Each question reads its own tables, so one failed read costs that panel only, and a failed read is a dash
 * with "Couldn't load this." and a Retry, never 0. The rows are filtered in the database to the chosen London months and loaded page
 * by page (lib/fetch-all); the page never uses the service role, so the signed-in admin's company and RLS decide what comes back.
 */
import { BarList, Panel } from "@/components/dashboard-charts";
import { CashBars } from "@/components/numbers-charts";
import { NumbersRedesign } from "@/components/numbers/numbers-redesign";
import { StatTile } from "@/components/stat-tile";
import { gbp } from "@/lib/money";
import { useCompanyUiSwitch } from "@/lib/use-company-ui-switch";
import { MONTH_CHOICES, useNumbersView, type NumbersScreen } from "@/lib/use-numbers-view";

const FAILED = "Couldn't load this.";

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-4 text-sm text-ink" data-testid="numbers-failed">
      <span className="font-semibold tabular-nums">—</span> {FAILED}
      <button type="button" onClick={onRetry} className="font-semibold text-brand-accent hover:underline">Retry</button>
    </p>
  );
}

export default function NumbersPage() {
  const redesign = useCompanyUiSwitch("ui-numbers-v2:on");
  const screen = useNumbersView();
  if (!screen.admin) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  return redesign ? <NumbersRedesign {...screen} /> : <LegacyNumbersView {...screen} />;
}

function LegacyNumbersView({ months, setMonths, retry, view, customers, customerRows, anyCash, span }: NumbersScreen) {
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
