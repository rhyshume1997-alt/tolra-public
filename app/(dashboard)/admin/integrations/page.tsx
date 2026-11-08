"use client";

import { Suspense } from "react";

import Link from "next/link";

import { AccountingStatusCard } from "@/components/integrations/accounting-status-card";
import { IntegrationsOverview } from "@/components/integrations/integrations-overview";
import { XeroBatchCard } from "@/components/integrations/xero-batch-card";
import { RoleGate } from "@/components/role-gate";

/** AI is switched on and off in ONE place, the AI card above. This points to the page that holds the per-feature settings. */
function AiMoreNote() {
  return (
    <p className="text-sm text-slate-600" data-testid="ai-more-note">
      AI is switched on or off in the AI card above. Which AI features are used, and the monthly limit, are on the{" "}
      <Link href="/ai-helper" className="underline">AI settings page</Link>.
    </p>
  );
}

/**
 * Admin > Integrations: guided setup for this company's AI, Xero, Microsoft 365 and Resend (four cards, each with its own switch, off by
 * default), then "More" (the accountant tools, accounting clouds, send log, the Xero date-range send, and a pointer to the AI settings page). Admins only.
 */
export default function AdminIntegrationsPage() {
  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-6">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="mt-2 text-sm text-slate-500">Connect AI, Xero and e-mail one step at a time. Everything here is off until an admin connects it and turns it on.</p>
        </div>
        <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
          <IntegrationsOverview moreCards={<><AiMoreNote /><AccountingStatusCard /><XeroBatchCard /></>} />
        </Suspense>
      </div>
    </RoleGate>
  );
}
