"use client";

/** Live AI presentation. Uses the existing scoped status hook and feature panels for all reads and actions. */
import Link from "next/link";

import { AiAssistantPanel } from "@/components/ai-helper/assistant-panel";
import { AiRfqPanel } from "@/components/ai-helper/rfq-panel";
import { AiRoundupPanel } from "@/components/ai-helper/roundup-panel";
import { anyFeatureOn, useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { AiWhatItShows } from "@/components/ai-helper/what-it-shows";
import { Callout, EmptyState, FailedState, LoadingState, PageHeader, premiumTokens } from "@/components/ui/premium";

import styles from "./ai-helper-redesign.module.css";

export function AiHelperRedesign() {
  const { status, loaded, allowed, reload } = useAiHelperStatus();
  const refresh = () => void reload();
  const setup = (
    <Link className="inline-flex min-h-12 items-center font-semibold underline" href="/admin/integrations#ai">
      Open Admin &gt; Integrations
    </Link>
  );

  return (
    <div className={`${premiumTokens} ${styles.screen}`} data-testid="ai-helper-v2">
      <PageHeader
        title="AI"
        description="Suggestions for office paperwork. A person checks and approves everything."
      />
      {!loaded ? <LoadingState label="Loading AI settings" /> : !allowed ? (
        <EmptyState title="The AI section is not switched on for this server." headingLevel={2} />
      ) : !status ? (
        <FailedState title="The AI section could not be loaded." detail="Try reading the company’s AI settings again." onRetry={refresh} headingLevel={2} />
      ) : (
        <>
          {!anyFeatureOn(status) ? (
            <EmptyState
              title="AI is off for this company."
              detail={status.can_manage ? "Turn it on in Admin > Integrations." : "An admin can turn it on in Admin > Integrations."}
              action={status.can_manage ? setup : undefined}
              headingLevel={2}
            />
          ) : (
            <Callout tone="neutral" action={status.can_manage ? setup : undefined}>
              An admin manages the AI key, feature switches and monthly limit in Admin &gt; Integrations.
            </Callout>
          )}
          <AiWhatItShows />
          {status.roundup_enabled && <AiRoundupPanel onUsed={refresh} />}
          {status.rfq_enabled && <AiRfqPanel onUsed={refresh} />}
          {status.assistant_available && status.assistant_enabled && <AiAssistantPanel onUsed={refresh} />}
        </>
      )}
    </div>
  );
}
