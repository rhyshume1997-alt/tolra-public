/** ISO templates presentation. Existing company switch, read-only evidence and export actions are supplied as children. */
import type { ReactNode } from "react";
import { LoadingState, PageHeader, premiumTokens } from "@/components/ui/premium";

export function IsoPackRedesign({ companyName, switching, ready, children }: {
  companyName: string;
  switching: ReactNode;
  ready: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_section]:min-w-0 [&_section>div]:max-w-full [&_section>div>div]:flex-wrap`} data-testid="admin-iso-v2">
      <PageHeader title="ISO templates" description={`Branded draft templates and a self-check list for ${companyName}. Review them before use. Drafts and the self-check list do not provide certification evidence.`} />
      {switching}
      {ready ? children : <LoadingState label="Loading ISO templates" />}
    </div>
  );
}
