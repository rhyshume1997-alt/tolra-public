/** Presentation for the existing scoped Xero offer and authenticator-confirmed action. */
import Link from "next/link";
import type { ReactNode } from "react";

import { Button, Callout, LoadingState, PageHeader, Panel, premiumTokens } from "@/components/ui/premium";

interface Props {
  organizations: Array<{ tenantId: string; name: string }> | null;
  problem: string | null;
  busy: boolean;
  chosen: string | null;
  choose: (tenantId: string) => void;
  connect: () => void;
  codeDialog: ReactNode;
}

export function XeroOrganisationRedesign({ organizations, problem, busy, chosen, choose, connect, codeDialog }: Props) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="admin-xero-v2">
      <PageHeader title="Confirm the Xero organisation" description="Choose the organisation for this company before connecting." />
      {problem && <Callout tone="error">{problem}</Callout>}
      {organizations ? (
        <Panel title="Organisations">
          <fieldset className="grid gap-2" disabled={busy}>
            <legend className="sr-only">Xero organisation</legend>
            {organizations.map((organization) => (
              <label key={organization.tenantId} className="flex min-h-12 items-center gap-3 rounded-md border p-3 text-sm">
                <input type="radio" name="tenant" value={organization.tenantId} checked={chosen === organization.tenantId} onChange={() => choose(organization.tenantId)} />
                <span className="break-words">{organization.name || "Unnamed organisation"}</span>
              </label>
            ))}
            <Button className="mt-2 w-fit" disabled={!chosen || busy} onClick={connect}>Connect this organisation</Button>
          </fieldset>
        </Panel>
      ) : !problem && <LoadingState label="Loading Xero organisations" />}
      <Link href="/admin/integrations" className="inline-flex min-h-12 items-center text-sm font-semibold underline">Back to Integrations</Link>
      {codeDialog}
    </div>
  );
}
