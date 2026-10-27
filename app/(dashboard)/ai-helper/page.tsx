"use client";

import { AiRfqPanel } from "@/components/ai-helper/rfq-panel";
import { AiRoundupPanel } from "@/components/ai-helper/roundup-panel";
import { anyFeatureOn, useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { RoleGate } from "@/components/role-gate";

const pounds = (pence: number) => (pence / 100).toFixed(2);

/**
 * The AI admin helper (office and admin). Shows only the features this server and this company have switched on; with none on it says
 * so and shows nothing else. Online only: nothing here is queued offline.
 */
export default function AiHelperPage() {
  const { status, loaded, reload } = useAiHelperStatus();
  return (
    <RoleGate allowed={["admin", "office"]}>
      <div className="space-y-6">
        <div>
          <h1 className="page-title">AI helper</h1>
          <p className="mt-2 text-sm text-slate-500">Suggestions for office paperwork. A person checks and approves everything; it never sends, issues, approves, voids, records payments or edits records.</p>
        </div>
        {!loaded ? <p className="text-sm text-slate-500">Loading...</p> : !anyFeatureOn(status) ? (
          <p className="rounded-lg border p-3 text-sm text-slate-600" data-testid="ai-helper-off">The AI helper is off for this company. An admin can turn it on in Settings.</p>
        ) : (
          <>
            <p className="text-xs text-slate-500" data-testid="ai-helper-usage">AI use this month: £{pounds(status!.month_spent_pence)} of £{pounds(status!.monthly_cap_pence)}.</p>
            {status!.roundup_enabled ? <AiRoundupPanel onUsed={() => void reload()} /> : null}
            {status!.rfq_enabled ? <AiRfqPanel onUsed={() => void reload()} /> : null}
          </>
        )}
      </div>
    </RoleGate>
  );
}
