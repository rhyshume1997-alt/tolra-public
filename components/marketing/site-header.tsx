import Link from "next/link";

import { BracketT } from "@/components/marketing/bracket-t";
import { SHEET_LABELS } from "@/lib/marketing";

const ZONES = ["1", "2", "3", "4", "5", "6", "7", "8"];

/** The header shared by the public pages ("/" and "/privacy"): the sheet's top border, with the drawing's zone numbers on wide screens. */
export function SiteHeader() {
  return (
    <header className="border-b border-[#0b2a5b]">
      <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10">
        <Link href="/" className="flex min-h-11 items-center gap-2.5 text-[#0b2a5b]">
          <BracketT variant="flat" size={30} bracket="#0b2a5b" ink="#0b2a5b" />
          <span className="mk-display text-[1.75rem] uppercase tracking-[0.1em]">Tolra</span>
        </Link>
        <nav aria-label="Main">
          <Link href="/login" className="mk-link inline-flex min-h-11 items-center px-1 text-base font-semibold">{SHEET_LABELS.signIn}</Link>
        </nav>
      </div>
      <div aria-hidden className="mx-auto hidden w-full max-w-[1240px] grid-cols-8 border-t border-[#0b2a5b]/30 px-10 lg:grid">
        {ZONES.map((zone) => (
          <span key={zone} className="mk-mono border-l border-[#0b2a5b]/30 py-0.5 text-center text-[0.6875rem] text-[#3c5277] last:border-r">{zone}</span>
        ))}
      </div>
    </header>
  );
}
