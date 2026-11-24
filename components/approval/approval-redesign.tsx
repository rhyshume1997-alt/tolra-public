/** Approval presentation. Receives existing draft cards, status and confirmation dialogs from the route. */
import type { ReactNode } from "react";

import { ColumnToggle } from "@/components/column-toggle";
import { APPROVAL_GUIDANCE } from "@/lib/approval-guidance";
import { Callout, EmptyState, FailedState, LoadingState, PageHeader, premiumTokens } from "@/components/ui/premium";

import styles from "./approval-redesign.module.css";

interface Props {
  draftCount: number;
  loading: boolean;
  error: string | null;
  noProvider: string | null;
  retry: () => void;
  renderDrafts: () => ReactNode;
  belowQueue: ReactNode;
}

export function ApprovalRedesign({ draftCount, loading, error, noProvider, retry, renderDrafts, belowQueue }: Props) {
  return (
    <div className={`${premiumTokens} ${styles.screen}`} data-testid="approval-v2">
      <PageHeader
        title="Approval Queue"
        description="Emails Tolra has drafted wait here for you to check before they go to customers."
        actions={<ColumnToggle tableKey="approvals" />}
      />
      <Callout tone="info">
        {APPROVAL_GUIDANCE}
        {!loading && !error && draftCount > 0 && ` ${draftCount} draft${draftCount === 1 ? "" : "s"} waiting.`}
      </Callout>
      {noProvider && <Callout tone="warn" role="status" data-testid="approval-no-provider">{noProvider}</Callout>}
      {error && <FailedState title="Couldn’t load the approval queue" detail={error} onRetry={retry} retryLabel="Retry" headingLevel={2} />}
      {loading ? <LoadingState label="Loading approval drafts" /> : !error && draftCount === 0 ? (
        <EmptyState title="Nothing waiting" detail="No drafted emails are waiting for approval." headingLevel={2} />
      ) : (
        <section className={styles.queue} aria-label="Drafts waiting for approval">{renderDrafts()}</section>
      )}
      {belowQueue}
    </div>
  );
}
