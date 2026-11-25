"use client";

/** Numbers presentation using the same view model, chart and bar list as the legacy screen. */
import { BarList } from "@/components/dashboard-charts";
import { CashBars } from "@/components/numbers-charts";
import { Callout, FailedState, LoadingState, PageHeader, Panel, ScrollTable, SegmentedControl, StatTile, StatTiles, premiumTokens } from "@/components/ui/premium";
import { gbp } from "@/lib/money";
import { MONTH_CHOICES, type NumbersScreen } from "@/lib/use-numbers-view";

const monthsOptions = MONTH_CHOICES.map((months) => ({ value: String(months), label: String(months) }));
const money = (value: number | null) => value === null ? "—" : gbp(value, 0);

export function NumbersRedesign({ months, setMonths, retry, view, customers, customerRows, anyCash, span }: NumbersScreen) {
  const failure = <FailedState title="Couldn’t load this." detail="Try loading the figures again." onRetry={retry} retryLabel="Retry" />;

  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="numbers-v2">
      <PageHeader title="Numbers" description={`${span}. Months follow the UK calendar.`} actions={(
        <SegmentedControl label="Months to show" value={String(months)} options={monthsOptions} onChange={(value) => setMonths(Number(value))} />
      )} />
      {!view ? <LoadingState label="Loading Numbers" /> : (
        <>
          <StatTiles label="Invoice and payment totals" columns={2}>
            <StatTile label="Invoiced ex VAT" value={money(view.invoicedTotal)} hint={view.invoicedTotal === null ? "Couldn’t load this." : "Issued invoices, less credit notes on their own date"} data-testid="numbers-invoiced" />
            <StatTile label="Received" value={money(view.receivedTotal)} hint={view.receivedTotal === null ? "Couldn’t load this." : "Payments by the date received, reversals included"} data-testid="numbers-received" />
          </StatTiles>
          <Panel title="Which customers are we relying on?" className="min-w-0" data-testid="numbers-customers">
            {customers && customers.topCustomer && customers.topShare !== null && <p className="mb-3 text-sm">Largest: {customers.topCustomer}, {customers.topShare}%</p>}
            {customers === undefined ? failure : customers === null ? (
              <Callout tone="warn">Some invoices have no figures, so the shares can’t be worked out yet.</Callout>
            ) : <BarList rows={customerRows} format={(value) => gbp(value, 0)} empty="No invoiced work in these months." />}
          </Panel>
          <Panel title="Are invoices turning into cash?" className="min-w-0" data-testid="numbers-cash">
            {!anyCash ? failure : (
              <div className="min-w-0 space-y-3">
                <CashBars data={view.cash} />
                <p className="text-sm">The gap is invoiced less received in that month, not money owed: a payment can settle an invoice from an earlier month.</p>
                <ScrollTable label="Invoiced, received and gap by month" dense flush>
                  <thead><tr><th scope="col">Month</th><th scope="col">Invoiced</th><th scope="col">Received</th><th scope="col">Gap</th></tr></thead>
                  <tbody>
                    {view.cash.map((month) => (
                      <tr key={month.key} data-testid={`numbers-cash-${month.key}`}>
                        <th scope="row">{month.label}</th>
                        <td className="tabular-nums">{money(month.invoiced)}</td>
                        <td className="tabular-nums">{money(month.received)}</td>
                        <td className="tabular-nums">{money(month.gap)}</td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
                {(!view.invoicedRead || !view.receivedRead) && failure}
              </div>
            )}
          </Panel>
          <Panel title="Where is machine time going?" className="min-w-0" data-testid="numbers-machines">
            <p className="mb-3 text-sm">Recorded machine runs, not booked hours.</p>
            {view.machines === null ? failure : (
              <BarList rows={view.machines.map((row) => ({ key: row.id, label: row.machine, value: row.hours }))} format={(value) => `${value} h`} empty="No machine time recorded in these months." />
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
