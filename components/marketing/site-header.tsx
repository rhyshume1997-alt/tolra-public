import Link from "next/link";

import { BracketT } from "@/components/marketing/bracket-t";

const focusDark = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** The header shared by the public pages ("/" and "/privacy"). */
export function SiteHeader() {
  return (
    <header className="bg-[#0b2a5b] text-white">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" className={`flex items-center gap-2 rounded-md text-xl font-bold tracking-tight ${focusDark}`}>
          <BracketT variant="flat" size={32} />
          <span>Tolra</span>
        </Link>
        <nav aria-label="Main">
          <Link href="/login" className={`inline-flex min-h-11 items-center rounded-lg border border-white/50 px-4 text-sm font-semibold hover:bg-white/10 ${focusDark}`}>Sign in</Link>
        </nav>
      </div>
    </header>
  );
}
