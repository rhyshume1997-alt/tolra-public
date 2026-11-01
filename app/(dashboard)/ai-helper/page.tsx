"use client";

import { AiAssistantPanel } from "@/components/ai-helper/assistant-panel";
import { AiCustomisedCard } from "@/components/ai-helper/customised-card";
import { AiMasterCard } from "@/components/ai-helper/master-card";
import { AiRfqPanel } from "@/components/ai-helper/rfq-panel";
import { AiRoundupPanel } from "@/components/ai-helper/roundup-panel";
import { anyFeatureOn, useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { AiWhatItShows } from "@/components/ai-helper/what-it-shows";
import { RoleGate } from "@/components/role-gate";

/**
 * The AI section (office and admin; anyone else gets the role gate's message): the one place for the company's AI. The master on/off
 * switch with one switch per feature, what each feature shows, how it is customised (the company's own key, monthly limit, who can use
 * it), and the working panels for whichever features are on. Hidden entirely when this server has the AI helper off. Online only:
 * nothing here is queued offline.
 */
export default function AiHelperPage() {
  const { status, loaded, allowed, reload, setStatus } = useAiHelperStatus();
  return (
    <RoleGate allowed={["admin", "office"]}>
      <div className="space-y-6">
        <div>
          <h1 className="page-title">AI</h1>
          <p className="mt-2 text-sm text-slate-500">Suggestions for office paperwork. A person checks and approves everything; it never sends, issues, approves, voids, records payments or edits records.</p>
        </div>
        {!loaded ? <p className="text-sm text-slate-500">Loading...</p> : !allowed ? (
          <p className="rounded-lg border p-3 text-sm text-slate-600" data-testid="ai-helper-unavailable">The AI section is not switched on for this server.</p>
        ) : !status ? (
          <p className="rounded-lg border p-3 text-sm text-slate-600" data-testid="ai-helper-error">The AI section could not be loaded. Try again in a moment.</p>
        ) : (
          <>
            {!anyFeatureOn(status) ? (
              <p className="rounded-lg border p-3 text-sm text-slate-600" data-testid="ai-helper-off">AI is off for this company.{status.can_manage ? " Turn it on below." : " An admin can turn it on in this section."}</p>
            ) : null}
            <AiMasterCard status={status} onStatus={setStatus} />
            <AiWhatItShows />
            <AiCustomisedCard status={status} onStatus={setStatus} />
            {status.roundup_enabled ? <AiRoundupPanel onUsed={() => void reload()} /> : null}
            {status.rfq_enabled ? <AiRfqPanel onUsed={() => void reload()} /> : null}
            {status.assistant_available && status.assistant_enabled ? <AiAssistantPanel onUsed={() => void reload()} /> : null}
          </>
        )}
      </div>
    </RoleGate>
  );
}
