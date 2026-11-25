/** Quote Generator presentation. Receives the real screen actions and panels from the route. */
import type { ReactNode } from "react";
import { readAiDraftNotes } from "@/lib/ai-helper/draft-notes";
import { PageHeader, premiumTokens } from "@/components/ui/premium";

export interface QuotesViewProps {
  actions: ReactNode;
  legacyHeader: ReactNode;
  children: ReactNode;
}

export function QuotesRedesign({ actions, children }: QuotesViewProps) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="quotes-v2">
      <PageHeader title="Quote Generator" description="A quote is the price we offer a customer. Make, send and follow up quotes here." actions={actions} />
      {children}
    </div>
  );
}

/** A draft the AI helper suggested: the "AI-suggested" badge and each "Needs human review" item, read from its internal notes. */
export function AiDraftFlags({ notes }: { notes: string }) {
  const flags = readAiDraftNotes(notes);
  if (!flags.aiSuggested) return null;
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="quote-ai-flags">
      <p><span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">AI-suggested</span> <span className="text-slate-700">Drafted by the AI helper from an RFQ email and approved by a person. Check it before sending.</span></p>
      {flags.review.length ? (
        <ul className="flex flex-wrap gap-1" aria-label="Needs human review">
          {flags.review.map((item) => <li key={item} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Needs human review: {item}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/** The existing (OFF) layout: the legacy header above the page content. */
export function LegacyQuotesView({ legacyHeader, children }: QuotesViewProps) {
  return <div className="space-y-6">{legacyHeader}{children}</div>;
}
