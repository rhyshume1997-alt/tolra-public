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

const body = "mt-3 text-lg leading-relaxed text-[#3c5277]";

export default function Privacy() {
  const contact = privacyContact();
  return (
    <MarketingSheet>
      <SiteHeader />
      <main id="main" className="flex-1">
        <div className="mx-auto w-full max-w-[1240px] px-4 py-12 sm:px-6 lg:px-10 lg:py-16">
          <div className="max-w-3xl border border-[#0b2a5b] bg-white px-5 py-8 sm:px-10 sm:py-10">
            <h1 className="mk-display text-[clamp(2.75rem,6vw,4rem)] uppercase">{PRIVACY_LABEL}</h1>
            <p className="mk-mono mt-3 text-sm text-[#3c5277]">{PRIVACY_UPDATED}</p>
            {PRIVACY_SECTIONS.map((section) => (
              <section key={section.id} aria-labelledby={`privacy-${section.id}`} className="mt-10 border-t border-[#0b2a5b]/30 pt-5">
                <h2 id={`privacy-${section.id}`} className="mk-display text-[1.875rem]">{section.title}</h2>
                {section.id === "who" ? <p className={body}>{privacyWhoIAm()}</p> : null}
                {section.paragraphs?.map((paragraph) => (
                  <p key={paragraph} className={body}>{paragraph}</p>
                ))}
                {section.list ? (
                  <ul className="mt-3 list-disc space-y-2 pl-6 text-lg leading-relaxed text-[#3c5277] marker:text-[#0b2a5b]">
                    {section.list.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : null}
                {section.id === "rights" ? (
                  <p className={body}>
                    {contact.before}
                    <a href={contact.href} className="mk-link break-words font-semibold" {...(contact.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{contact.linkText}</a>
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
