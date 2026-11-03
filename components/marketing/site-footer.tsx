import Link from "next/link";
import type { ReactNode } from "react";

import { BracketT } from "@/components/marketing/bracket-t";
import { CONTACT_EMAIL, FOUNDER_NAME, PRIVACY_LABEL, PRIVACY_NOTE, PRIVACY_PATH, SHEET_LABELS, TITLE_BLOCK } from "@/lib/marketing";

function Cell({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`border-b border-r border-[#0b2a5b] px-3 py-2.5 ${className}`}>
      <p className="mk-label">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * The footer shared by the public pages ("/" and "/privacy"), drawn as a drawing's title block: title, drawn by, checked, rev, date and
 * sheet, plus the contact email (only when set), the one-line privacy note and the Privacy and Sign in links.
 */
export function SiteFooter() {
  const by = FOUNDER_NAME || "Tolra";
  return (
    <footer className="mx-auto mt-auto w-full max-w-[1240px] px-4 pb-8 pt-4 sm:px-6 lg:px-10">
      <div className="grid grid-cols-2 border-l border-t border-[#0b2a5b] bg-white text-[0.9375rem] leading-snug lg:grid-cols-12">
        <div className="col-span-2 flex items-center gap-3 border-b border-r border-[#0b2a5b] px-3 py-4 lg:col-span-3 lg:row-span-2">
          <BracketT variant="flat" size={40} bracket="#0b2a5b" ink="#0b2a5b" />
          <div>
            <p className="mk-display text-[2rem] uppercase tracking-[0.1em]">Tolra</p>
            <p className="mk-label">{TITLE_BLOCK.place}</p>
          </div>
        </div>
        <Cell label={SHEET_LABELS.title} className="col-span-2 lg:col-span-5"><p className="mk-display text-xl">{TITLE_BLOCK.title}</p></Cell>
        <Cell label={SHEET_LABELS.drawnBy} className="lg:col-span-2"><p className="mk-mono">{by}</p></Cell>
        <Cell label={SHEET_LABELS.checked} className="lg:col-span-2"><p className="mk-mono">{by}</p></Cell>
        <Cell label={SHEET_LABELS.notes} className="col-span-2 lg:col-span-5">
          <div className="space-y-1 text-[#3c5277]">
            {CONTACT_EMAIL ? <p>Email: <a href={`mailto:${CONTACT_EMAIL}`} className="mk-link break-all font-semibold">{CONTACT_EMAIL}</a></p> : null}
            <p>{PRIVACY_NOTE}</p>
          </div>
        </Cell>
        <Cell label={SHEET_LABELS.rev} className="lg:col-span-1"><p className="mk-mono">{TITLE_BLOCK.rev}</p></Cell>
        <Cell label={SHEET_LABELS.date} className="lg:col-span-2"><p className="mk-mono">{TITLE_BLOCK.date}</p></Cell>
        <Cell label={SHEET_LABELS.sheet} className="col-span-2 lg:col-span-1"><p className="mk-mono">{TITLE_BLOCK.sheet}</p></Cell>
        <div className="col-span-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-r border-[#0b2a5b] px-3 py-1 lg:col-span-12">
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6">
            <Link href={PRIVACY_PATH} className="mk-link inline-flex min-h-11 items-center font-semibold">{PRIVACY_LABEL}</Link>
            <Link href="/login" className="mk-link inline-flex min-h-11 items-center font-semibold">{SHEET_LABELS.signIn}</Link>
          </nav>
          <p className="mk-mono text-sm">&copy; Tolra</p>
        </div>
      </div>
    </footer>
  );
}
