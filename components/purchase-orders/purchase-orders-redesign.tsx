/** Purchase Orders view. Selection, filtering, dialogs and record actions are supplied by the route. */
import type { ReactNode } from "react";

import { Button, Callout, EmptyState, FailedState, LoadingState, PageHeader, StatTile, StatTiles, premiumTokens } from "@/components/ui/premium";
import { purchaseOrdersEmptyHint } from "@/lib/empty-hints";

interface Props {
  actions: ReactNode;
  demo: boolean;
  tiles: ReadonlyArray<readonly [label: string, value: number, statuses: readonly string[]]>;
  filters: Set<string>;
  chooseFilter: (statuses: readonly string[]) => void;
  controls: ReactNode;
  records: ReactNode;
  dialogs: ReactNode;
  loading: boolean;
  error: string | null;
  retry: () => void;
  hasRecords: boolean;
  hasVisible: boolean;
  showAll: () => void;
  add: () => void;
}

export function PurchaseOrdersRedesign({ actions, demo, tiles, filters, chooseFilter, controls, records, dialogs, loading, error, retry, hasRecords, hasVisible, showAll, add }: Props) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="purchase-orders-v2">
      <PageHeader title="Purchase Orders" description="Purchase orders are what we buy from suppliers." actions={actions} />
      {demo && <Callout tone="warn">Demo mode: sample data is shown if the database can’t be reached.</Callout>}
      <StatTiles label="Purchase Orders counts" columns={3}>
        {tiles.map(([label, value, statuses]) => (
          <StatTile key={label} label={label} value={loading || error ? "—" : value} onPress={() => chooseFilter(statuses)} pressed={filters.size === statuses.length && statuses.every((status) => filters.has(status))} />
        ))}
      </StatTiles>
      {controls}
      {error && <FailedState title="Couldn’t load purchase orders" detail={error} onRetry={retry} retryLabel="Retry" headingLevel={2} />}
      {loading ? <LoadingState label="Loading purchase orders" /> : error && !demo ? null : !hasVisible ? (
        <EmptyState
          title={hasRecords ? "No purchase orders match this filter" : "No purchase orders yet"}
          detail={hasRecords ? "Try a different filter." : purchaseOrdersEmptyHint()}
          action={hasRecords ? <Button variant="secondary" onClick={showAll}>Show all</Button> : <Button onClick={add}>New purchase order</Button>}
          headingLevel={2}
        />
      ) : (
        <section aria-label="Purchase Orders" className="min-w-0 [&_[data-actions]_button]:min-h-12 [&_[data-slot=card]]:rounded-[14px]">{records}</section>
      )}
      {dialogs}
    </div>
  );
}
