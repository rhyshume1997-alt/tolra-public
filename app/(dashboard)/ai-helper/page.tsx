"use client";

import Link from "next/link";

import { AiAssistantPanel } from "@/components/ai-helper/assistant-panel";
import { AiRfqPanel } from "@/components/ai-helper/rfq-panel";
import { AiRoundupPanel } from "@/components/ai-helper/roundup-panel";
import { anyFeatureOn, useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { AiWhatItShows } from "@/components/ai-helper/what-it-shows";
import { RoleGate } from "@/components/role-gate";

/** Where AI is set up: the AI card on Admin > Integrations (the page's #ai anchor). */
const AI_SETUP_HREF = "/admin/integrations#ai";

/**
 * The AI section (office and admin; anyone else gets the role gate's message): what each feature shows and the working panels for whichever
 * features are on. Setting AI up (the company's own key, the on/off switch, Tolra-provided AI, the monthly limit) is NOT done here any more: those
 * actions need a fresh authenticator code, which only the AI card on Admin > Integrations asks for. This page says so and links there, so there is no
 * button here that the server would refuse. Hidden entirely when this server has the AI helper off. Online only: nothing here is queued offline.
 */
export default function AiHelperPage() {
  const { status, loaded, allowed, reload } = useAiHelperStatus();
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
              <p className="rounded-lg border p-3 text-sm text-slate-600" data-testid="ai-helper-off">AI is off for this company.{status.can_manage ? " Turn it on in Admin > Integrations." : " An admin can turn it on in Admin > Integrations."}</p>
            ) : null}
            <div className="rounded-lg border p-3 text-sm text-slate-700" data-testid="ai-helper-manage-notice">
              {status.can_manage ? (
                <p>
                  AI is set up in one place now, the AI card on Admin &gt; Integrations: your key, the on/off switch, Tolra-provided AI and the monthly limit.{" "}
                  <Link href={AI_SETUP_HREF} className="font-medium underline" data-testid="ai-helper-manage-link">Open Admin &gt; Integrations</Link>
                </p>
              ) : (
                <p>Only an admin sets up AI or turns it on or off. They do it in the AI card on Admin &gt; Integrations.</p>
              )}
            </div>
            <AiWhatItShows />
            {status.roundup_enabled ? <AiRoundupPanel onUsed={() => void reload()} /> : null}
            {status.rfq_enabled ? <AiRfqPanel onUsed={() => void reload()} /> : null}
            {status.assistant_available && status.assistant_enabled ? <AiAssistantPanel onUsed={() => void reload()} /> : null}
          </>
        )}
      </div>
    </RoleGate>
  );
}
