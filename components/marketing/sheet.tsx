import type { ReactNode } from "react";

import { marketingFontVariables } from "@/components/marketing/fonts";
import "@/components/marketing/marketing.css";

/** The drawing sheet every public page sits on: the marketing faces, the paper and its 10 mm grid. */
export function MarketingSheet({ children }: { children: ReactNode }) {
  return <div className={`${marketingFontVariables} mk-sheet flex flex-col`}>{children}</div>;
}

/** A section divider drawn as a dimension line, with a section reference ("A") in the middle. Decoration only. */
export function DimensionLine({ reference, className = "" }: { reference: string; className?: string }) {
  return (
    <div aria-hidden className={`mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-10 ${className}`}>
      <div className="mk-dim">
        <span className="mk-dim-ext" />
        <span className="mk-dim-line" data-end="start" />
        <span className="mk-mono text-xs tracking-[0.12em]">{reference}–{reference}</span>
        <span className="mk-dim-line" data-end="end" />
        <span className="mk-dim-ext" />
      </div>
    </div>
  );
}
