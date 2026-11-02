import Link from "next/link";

import { BracketT } from "@/components/marketing/bracket-t";
import { CONTACT_EMAIL, PRIVACY_LABEL, PRIVACY_NOTE, PRIVACY_PATH } from "@/lib/marketing";

const focusDark = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** The footer shared by the public pages ("/" and "/privacy"): the contact email (only when set), the one-line privacy note and the Privacy link. */
export function SiteFooter() {
  return (
    <footer className="bg-[#08224a] py-10 text-sm text-blue-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-md space-y-2">
          <p className="flex items-center gap-2 text-base font-bold text-white"><BracketT variant="flat" size={24} />Tolra</p>
          {CONTACT_EMAIL ? <p>Email: <a href={`mailto:${CONTACT_EMAIL}`} className={`rounded font-semibold text-white underline underline-offset-4 ${focusDark}`}>{CONTACT_EMAIL}</a></p> : null}
          <p>{PRIVACY_NOTE}</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link href={PRIVACY_PATH} className={`inline-flex min-h-11 items-center rounded font-semibold text-white underline underline-offset-4 ${focusDark}`}>{PRIVACY_LABEL}</Link>
          <Link href="/login" className={`inline-flex min-h-11 items-center rounded font-semibold text-white underline underline-offset-4 ${focusDark}`}>Sign in</Link>
        </nav>
      </div>
      <p className="mx-auto mt-6 w-full max-w-6xl px-4 sm:px-6">&copy; Tolra</p>
    </footer>
  );
}
