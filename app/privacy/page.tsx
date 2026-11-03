import type { Metadata } from "next";

import { MarketingSheet } from "@/components/marketing/sheet";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import {
  MARKETING_ICONS, PRIVACY_DESCRIPTION, PRIVACY_LABEL, PRIVACY_PATH, PRIVACY_SECTIONS, PRIVACY_TITLE, PRIVACY_UPDATED, SITE_URL, privacyContact, privacyWhoIAm,
} from "@/lib/marketing";

// The public privacy page. Signed-out visitors can read it (middleware.ts lets /privacy through the way it does "/").
export const metadata: Metadata = {
  title: { absolute: PRIVACY_TITLE },
  description: PRIVACY_DESCRIPTION,
  alternates: { canonical: `${SITE_URL}${PRIVACY_PATH}` },
  robots: { index: true, follow: true },
  icons: MARKETING_ICONS,
};

/**
 * Running text: about 68 characters a line. A CSS ch is the width of a zero, wider than Plex Sans's average letter, so 68ch came out
 * near 91 characters; 52ch is about 68-72.
 */
const body = "mt-3 max-w-[52ch] text-lg leading-relaxed text-[#3c5277]";

export default function Privacy() {
  const contact = privacyContact();
  return (
    <MarketingSheet>
      <SiteHeader />
      <main id="main" className="flex-1">
        <div className="mx-auto w-full max-w-[1240px] px-4 py-12 sm:px-6 lg:px-10 lg:py-16">
          {/* The sheet holds the text measure plus its padding; the section headings are numbered by CSS counters (marketing.css .mk-numbered). */}
          <div className="mk-numbered max-w-[calc(52ch+5rem+2px)] border border-[#0b2a5b] bg-white px-5 py-8 text-lg sm:px-10 sm:py-10">
            <h1 className="mk-display text-[clamp(2.75rem,6vw,4rem)] uppercase">{PRIVACY_LABEL}</h1>
            <p className="mk-mono mt-3 text-sm text-[#3c5277]">{PRIVACY_UPDATED}</p>
            {PRIVACY_SECTIONS.map((section) => (
              <section key={section.id} aria-labelledby={`privacy-${section.id}`} className="mt-10 border-t border-[#0b2a5b]/30 pt-5">
                <h2 id={`privacy-${section.id}`} className="mk-display text-[1.875rem] uppercase">{section.title}</h2>
                {section.id === "who" ? <p className={body}>{privacyWhoIAm()}</p> : null}
                {section.paragraphs?.map((paragraph) => (
                  <p key={paragraph} className={body}>{paragraph}</p>
                ))}
                {section.list ? (
                  <ul className="mt-3 max-w-[52ch] list-disc space-y-2 pl-6 text-lg leading-relaxed text-[#3c5277] marker:text-[#0b2a5b]">
                    {section.list.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : null}
                {section.id === "rights" ? (
                  <p className={body}>
                    {contact.before}
                    <a href={contact.href} className="mk-link -my-3 inline-block break-words py-3 font-semibold" {...(contact.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{contact.linkText}</a>
                    {contact.after}
                  </p>
                ) : null}
              </section>
            ))}
          </div>
        </div>
      </main>
      <SiteFooter />
    </MarketingSheet>
  );
}
