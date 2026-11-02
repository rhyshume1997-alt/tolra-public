import type { Metadata } from "next";

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

const focusLight = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b5fc4]";
const linkClass = `rounded font-semibold text-[#0b5fc4] underline underline-offset-4 hover:text-[#0b2a5b] ${focusLight}`;

export default function Privacy() {
  const contact = privacyContact();
  return (
    <>
      <SiteHeader />
      <main id="main" className="bg-white text-slate-900">
        <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 md:py-16">
          <h1 className="text-4xl font-bold tracking-tight text-[#0b2a5b]">{PRIVACY_LABEL}</h1>
          <p className="mt-3 text-base text-slate-700">{PRIVACY_UPDATED}</p>
          {PRIVACY_SECTIONS.map((section) => (
            <section key={section.id} aria-labelledby={`privacy-${section.id}`} className="mt-10">
              <h2 id={`privacy-${section.id}`} className="text-2xl font-bold tracking-tight text-[#0b2a5b]">{section.title}</h2>
              {section.id === "who" ? <p className="mt-3 text-lg leading-relaxed text-slate-700">{privacyWhoIAm()}</p> : null}
              {section.paragraphs?.map((paragraph) => (
                <p key={paragraph} className="mt-3 text-lg leading-relaxed text-slate-700">{paragraph}</p>
              ))}
              {section.list ? (
                <ul className="mt-3 list-disc space-y-2 pl-6 text-lg leading-relaxed text-slate-700">
                  {section.list.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
              {section.id === "rights" ? (
                <p className="mt-3 text-lg leading-relaxed text-slate-700">
                  {contact.before}
                  <a href={contact.href} className={`${linkClass} break-words`} {...(contact.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{contact.linkText}</a>
                  {contact.after}
                </p>
              ) : null}
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
