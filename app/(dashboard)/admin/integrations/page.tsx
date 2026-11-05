"use client";

import { Suspense } from "react";

import { AiConnectionCard } from "@/components/integrations/ai-connection-card";
import { IntegrationsOverview } from "@/components/integrations/integrations-overview";
import { TolraAiConnectionCard } from "@/components/integrations/tolra-ai-card";
import { XeroBatchCard } from "@/components/integrations/xero-batch-card";
import { RoleGate } from "@/components/role-gate";

/**
 * Admin > Integrations: guided setup for this company's AI, Xero, Microsoft 365 and Resend (four cards, each with its own switch, off by
 * default), then "More" (the accountant tools, accounting clouds, send log, and the earlier AI and Xero batch cards). Admins only.
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
          <IntegrationsOverview moreCards={<><AiConnectionCard /><XeroBatchCard /><TolraAiConnectionCard /></>} />
        </Suspense>
      </div>
    </RoleGate>
  );
}
