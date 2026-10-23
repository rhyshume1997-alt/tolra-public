// The daily sweep (Lot B §2.1 and §2.6 step 5), for the cron route the IP-purge PR's cron foundation (vercel.json, the CRON_SECRET guard)
// will call: for each company connected to a provider, renew the sign-in (a Xero refresh token lapses after about 60 days unused) and send
// what is queued (retries whose time has come included). One company's failure never stops the others; counts only are returned (no
// company names, no document numbers, no tokens).

import type { RunSummary } from "@/lib/integrations/engine";
import type { ProviderId } from "@/lib/integrations/types";

export type SweepDeps = {
  /** Companies with a live connection (connected), per provider. */
  connected(): Promise<Array<{ organizationId: string; provider: ProviderId }>>;
  /** Forces a refresh under the lease; null when the company must connect again. */
  renew(org: string, provider: ProviderId): Promise<string | null>;
  send(org: string, provider: ProviderId): Promise<RunSummary>;
};

export type SweepSummary = { companies: number; renewed: number; needReconnect: number; sent: number; failed: number; needsCheck: number; errors: number };

export async function runIntegrationSweep(deps: SweepDeps): Promise<SweepSummary> {
  const out: SweepSummary = { companies: 0, renewed: 0, needReconnect: 0, sent: 0, failed: 0, needsCheck: 0, errors: 0 };
  for (const { organizationId, provider } of await deps.connected()) {
    out.companies += 1;
    try {
      if (!(await deps.renew(organizationId, provider))) {
        out.needReconnect += 1;
        continue;
      }
      out.renewed += 1;
      const run = await deps.send(organizationId, provider);
      out.sent += run.sent;
      out.failed += run.failed;
      out.needsCheck += run.needsCheck;
    } catch {
      out.errors += 1;
    }
  }
  return out;
}
