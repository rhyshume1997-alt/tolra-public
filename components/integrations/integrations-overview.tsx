"use client";

import { useEffect, useState, type ReactNode } from "react";

import { EmailChoiceGuide } from "@/components/email-choice-guide";
import { AiSetupCard } from "@/components/integrations/ai-setup-card";
import { MicrosoftSetupCard } from "@/components/integrations/microsoft-setup-card";
import { ResendSetupCard } from "@/components/integrations/resend-setup-card";
import { XeroSetupCard } from "@/components/integrations/xero-setup-card";
import { IntegrationsPanel } from "@/components/integrations-panel";
import type { ConnectStatus } from "@/components/microsoft-connect-card";
import { useUser } from "@/lib/use-user";

/**
 * Admin > Integrations, guided setup (W-F4): four cards in the one shared frame, in this order: AI, Xero, Microsoft 365, Resend. Each has its
 * own On/Off switch (or states plainly why it has none), OFF by default, separate from "connected". The e-mail guide sits above the two e-mail
 * cards. Everything the page offered before stays available under "More". Admin-only (the page's RoleGate); this component renders no secret and
 * holds none: each card reads only its own status and secrets never leave the server.
 */
export function IntegrationsOverview({ moreCards }: { moreCards?: ReactNode } = {}) {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [microsoftStatus, setMicrosoftStatus] = useState<string | null>(null);
  const { organizations } = useUser();
  const company = organizations.find((org) => org.is_current)?.name ?? null;

  useEffect(() => {
    let active = true;
    void fetch("/api/integrations/status", { credentials: "same-origin" })
      .then(async (res) => (res.ok ? ((await res.json()) as ConnectStatus) : null))
      .catch(() => null)
      .then((value) => { if (active) setStatus(value ?? { db107: false, xero: { configured: true }, microsoft: { configured: false } }); });
    return () => { active = false; };
  }, []);

  return (
    <div className="space-y-6" data-testid="integrations-overview">
      {company ? <p className="text-sm text-slate-600" data-testid="integrations-company">For <strong>{company}</strong>. Each company has its own page: switch company to set up the other.</p> : null}
      <div className="grid gap-6" data-testid="integrations-setup-cards">
        <AiSetupCard />
        <XeroSetupCard />
        <EmailChoiceGuide />
        <MicrosoftSetupCard status={status} onConnectionChange={setMicrosoftStatus} />
        <ResendSetupCard microsoftStatus={microsoftStatus} />
      </div>
      <section className="space-y-4" aria-labelledby="integrations-more-title" data-testid="integrations-more">
        <h2 id="integrations-more-title" className="text-lg font-semibold text-slate-900">More</h2>
        <p className="text-sm text-slate-500">Everything else on this page: the accountant&apos;s tools, the accounting clouds, and the send log.</p>
        <IntegrationsPanel guided />
        {moreCards}
      </section>
    </div>
  );
}
