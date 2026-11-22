import Link from "next/link";
import type { ReactNode } from "react";

import { BracketT } from "@/components/marketing/bracket-t";
import { SHEET_LABELS } from "@/lib/marketing";

/**
 * The header shared by the public pages ("/" and "/privacy"): the sheet's top border.
 * Boundary: `menu` is an optional slot before the Sign in link (the home page puts Tooly's "Job stages" button there); with none, the header
 * is exactly as before. Must not change: the logo link, the Sign in link and the navigation label.
 */
export function SiteHeader({ menu }: { menu?: ReactNode }) {
  return (
    <header className={`border-b border-[#0b2a5b]${menu ? " relative z-40" : ""}`}>
      <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10">
        <Link href="/" className="flex min-h-11 items-center gap-2.5 text-[#0b2a5b]">
          <BracketT variant="flat" size={30} bracket="#0b2a5b" ink="#0b2a5b" />
          <span className="mk-display text-[1.75rem] uppercase tracking-[0.1em]">Tolra</span>
        </Link>
        <nav aria-label="Main" className="flex items-center gap-3 sm:gap-6">
          {menu}
          <Link href="/login" className="mk-link inline-flex min-h-11 items-center px-1 text-base font-semibold">{SHEET_LABELS.signIn}</Link>
        </nav>
      </div>
    </header>
  );
}
