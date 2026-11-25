/** RFQ list presentation. Existing route actions, filter rules, RFQ details and dialogs are passed through. */
import type { ReactNode } from "react";

import { EmptyState, FailedState, LoadingState, PageHeader, StatTile, StatTiles, premiumTokens } from "@/components/ui/premium";
import { rfqEmptyHint } from "@/lib/empty-hints";

import styles from "./rfq-redesign.module.css";

interface Props {
  actions: ReactNode;
  filters: ReactNode;
  dialogs: ReactNode;
  cards: ReactNode;
  tileValues: [string, string, string];
  activeFilters: Set<string>;
  filterBy: (value: string) => void;
  loading: boolean;
  error: string | null;
  retry: () => void;
  hasRfqs: boolean;
  hasVisible: boolean;
}

const tiles = [
  { filter: "new", label: "New RFQs" },
  { filter: "clarification", label: "Waiting for details" },
  { filter: "ready", label: "Ready to Quote" },
];

export function RfqRedesign({ actions, filters, dialogs, cards, tileValues, activeFilters, filterBy, loading, error, retry, hasRfqs, hasVisible }: Props) {
  return (
    <div className={`${premiumTokens} ${styles.screen}`} data-testid="rfq-v2">
      <PageHeader title="RFQ Control Centre" description="RFQ means request for quote: a customer asking us for a price." actions={actions} />
      <StatTiles columns={3} label="RFQ counts">
        {tiles.map(({ filter, label }, index) => (
          <StatTile key={filter} label={label} value={tileValues[index]} onPress={() => filterBy(filter)} pressed={activeFilters.has(filter)} />
        ))}
      </StatTiles>
      {filters}
      {loading ? <LoadingState label="Loading RFQs" /> : error ? (
        <FailedState title="Couldn’t load RFQs" detail={error} onRetry={retry} retryLabel="Retry" headingLevel={2} />
      ) : !hasVisible ? (
        <EmptyState title={hasRfqs ? "No RFQs match this filter" : "No RFQs yet"} detail={hasRfqs ? "Try a different filter." : rfqEmptyHint()} headingLevel={2} />
      ) : (
        <section className={styles.records} aria-label="Requests for quote">{cards}</section>
      )}
      {dialogs}
    </div>
  );
}
