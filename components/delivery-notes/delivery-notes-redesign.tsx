/** Delivery Notes view. Selection, filtering, dialogs and record actions are supplied by the route. */
import type { ReactNode } from "react";

import { Button, Callout, EmptyState, FailedState, LoadingState, PageHeader, StatTile, StatTiles, premiumTokens } from "@/components/ui/premium";
import { deliveryNotesEmptyHint } from "@/lib/empty-hints";

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

export function DeliveryNotesRedesign({ actions, demo, tiles, filters, chooseFilter, controls, records, dialogs, loading, error, retry, hasRecords, hasVisible, showAll, add }: Props) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="delivery-notes-v2">
      <PageHeader title="Delivery Notes" description="A delivery note goes with finished work. Despatch means sending finished work to the customer." actions={actions} />
      {demo && <Callout tone="warn">Demo mode: sample data is shown if the database can’t be reached.</Callout>}
      <StatTiles label="Delivery Notes counts" columns={3}>
        {tiles.map(([label, value, statuses]) => (
          <StatTile key={label} label={label} value={loading || error ? "—" : value} onPress={() => chooseFilter(statuses)} pressed={filters.size === statuses.length && statuses.every((status) => filters.has(status))} />
        ))}
      </StatTiles>
      {controls}
      {error && <FailedState title="Couldn’t load delivery notes" detail={error} onRetry={retry} retryLabel="Retry" headingLevel={2} />}
      {loading ? <LoadingState label="Loading delivery notes" /> : error && !demo ? null : !hasVisible ? (
        <EmptyState
          title={hasRecords ? "No delivery notes match this filter" : "No delivery notes yet"}
          detail={hasRecords ? "Try a different filter." : deliveryNotesEmptyHint()}
          action={hasRecords ? <Button variant="secondary" onClick={showAll}>Show all</Button> : <Button onClick={add}>New delivery note</Button>}
          headingLevel={2}
        />
      ) : (
        <section aria-label="Delivery Notes" className="min-w-0 [&_[data-actions]_button]:min-h-12 [&_[data-slot=card]]:rounded-[14px]">{records}</section>
      )}
      {dialogs}
    </div>
  );
}
