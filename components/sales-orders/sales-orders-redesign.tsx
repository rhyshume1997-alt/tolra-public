/** Sales Orders presentation. Receives the existing filtered order list, dialogs and actions. */
import type { ReactNode } from "react";

import { Button, Callout, EmptyState, FailedState, LoadingState, PageHeader, StatTile, StatTiles, premiumTokens } from "@/components/ui/premium";
import { salesOrdersEmptyHint } from "@/lib/empty-hints";

import styles from "./sales-orders-redesign.module.css";

interface Props {
  actions: ReactNode;
  demo: boolean;
  counts: { open: number; confirmed: number; despatched: number };
  filters: Set<string>;
  chooseCount: (value: string) => void;
  openNote: string;
  listControls: ReactNode;
  records: ReactNode;
  dialogs: ReactNode;
  loading: boolean;
  error: string | null;
  retry: () => void;
  hasOrders: boolean;
  hasVisible: boolean;
  showAll: () => void;
  add: () => void;
}

const countOptions = [{ key: "open", label: "Open" }, { key: "confirmed", label: "Confirmed" }, { key: "despatched", label: "Despatched" }] as const;

export function SalesOrdersRedesign({ actions, demo, counts, filters, chooseCount, openNote, listControls, records, dialogs, loading, error, retry, hasOrders, hasVisible, showAll, add }: Props) {
  return (
    <div className={`${premiumTokens} ${styles.screen}`} data-testid="sales-orders-v2">
      <PageHeader title="Sales Orders" description="A sales order is a customer’s confirmed order. Turn it into a job when work starts." actions={actions} />
      {demo && <Callout tone="warn">Demo mode: sample data is shown if the database can’t be reached.</Callout>}
      <StatTiles label="Sales order counts" columns={3}>
        {countOptions.map(({ key, label }) => (
          <StatTile key={key} label={label} value={loading || error ? "—" : counts[key]} hint={key === "open" ? openNote : undefined} onPress={() => chooseCount(key)} pressed={filters.has(key)} />
        ))}
      </StatTiles>
      {listControls}
      {error && <FailedState title="Couldn’t load sales orders" detail={error} onRetry={retry} retryLabel="Retry" headingLevel={2} />}
      {loading ? <LoadingState label="Loading sales orders" /> : error && !demo ? null : !hasVisible ? (
        <EmptyState
          title={hasOrders ? "No sales orders match this filter" : "No sales orders yet"}
          detail={hasOrders ? "Try a different filter." : salesOrdersEmptyHint()}
          action={hasOrders ? <Button variant="secondary" onClick={showAll}>Show all</Button> : <Button onClick={add}>New sales order</Button>}
          headingLevel={2}
        />
      ) : (
        <section aria-label="Sales orders" className={styles.records}>{records}</section>
      )}
      {dialogs}
    </div>
  );
}
