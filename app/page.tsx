import type { Metadata } from "next";

import { Cta } from "@/components/marketing/cta";
import { FeatureFigure } from "@/components/marketing/feature-figure";
import { JobFlow } from "@/components/marketing/job-flow";
import { DimensionLine, MarketingSheet } from "@/components/marketing/sheet";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import {
  CLOSE_CALL_LINE, CLOSE_TITLE, FAQ, FAQ_TITLE, FEATURES, FEATURES_TITLE, FOUNDER_LINK_LABEL, FOUNDER_NAME, FOUNDER_NOTE, FOUNDER_TITLE, FOUNDER_URL,
  HERO_SUBHEAD, HERO_TITLE, MARKETING_ICONS, PAIN_CARDS, PAIN_TITLE, PROOF_LINE, SEE_HOW_LABEL, SHEET_LABELS, SITE_DESCRIPTION, SITE_TITLE, SITE_URL,
  START_STEPS, START_TITLE, TRUST_ITEMS, WHO_TEXT, WHO_TITLE, jsonLd,
} from "@/lib/marketing";

// The public home page. Signed-in people never see it: the middleware sends them to /dashboard (middleware.ts).
const OG_IMAGE = { url: `${SITE_URL}/marketing/tolra-og.png`, width: 1200, height: 630, alt: "Tolra: job management for small CNC and fabrication shops" };

export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/` },
  robots: { index: true, follow: true },
  // The public pages link the new icon files; the app's pages keep the icon links from app/layout.tsx.
  icons: MARKETING_ICONS,
  openGraph: { type: "website", url: `${SITE_URL}/`, siteName: "Tolra", title: SITE_TITLE, description: SITE_DESCRIPTION, images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION, images: [OG_IMAGE.url] },
};

/** The sheet's column: one width and one gutter for every band, so the rules and dimension lines line up down the page. */
const SHEET = "mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-10";
const BAND = `${SHEET} py-14 lg:py-20`;
const H2 = "mk-display text-[clamp(2.25rem,4.4vw,3.5rem)] uppercase";
const MUTED = "text-[#3c5277]";

export default function Home() {
  return (
    <MarketingSheet>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()).replace(/</g, "\\u003c") }} />

      <SiteHeader />

      <main id="main" className="flex-1">
        {/* The sheet's first view: what Tolra is and the booking link on the left, one job on its traveller on the right. */}
        <section aria-labelledby="hero-title" className={`${SHEET} grid gap-12 pb-14 pt-10 lg:grid-cols-12 lg:gap-10 lg:pb-20 lg:pt-14`}>
          <div className="lg:col-span-7 lg:pr-6">
            <h1 id="hero-title" className="mk-display text-[clamp(2.75rem,5.6vw,4.75rem)] uppercase">{HERO_TITLE}</h1>
            <p className={`mt-6 max-w-[34rem] text-lg leading-relaxed ${MUTED}`}>{HERO_SUBHEAD}</p>
            <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
              <Cta />
              <a href="#flow-title" className="mk-link inline-flex min-h-11 items-center text-base font-semibold lg:hidden">{SEE_HOW_LABEL}</a>
            </div>
            <div className="mt-12 max-w-[34rem] border-t border-[#0b2a5b] pt-3">
              <p className="mk-label">{SHEET_LABELS.notes}</p>
              <ol className="mt-2 space-y-1.5 text-[0.9375rem]">
                {[PROOF_LINE, ...TRUST_ITEMS].map((note, index) => (
                  <li key={note} className="grid grid-cols-[1.75rem_1fr]">
                    <span className="mk-mono text-[#3c5277]">{index + 1}.</span>
                    <span className={index === 0 ? "font-semibold" : ""}>{note}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="lg:col-span-5">
            <JobFlow />
          </div>
        </section>

        <DimensionLine reference="A" />

        <section aria-labelledby="pain-title" className={`${BAND} grid gap-8 lg:grid-cols-12 lg:gap-10`}>
          <h2 id="pain-title" className={`${H2} self-start lg:sticky lg:top-8 lg:col-span-4`}>{PAIN_TITLE}</h2>
          <ul className="border-t border-[#0b2a5b] lg:col-span-8">
            {PAIN_CARDS.map((card) => (
              <li key={card.title} className="grid gap-2 border-b border-[#0b2a5b]/30 py-6 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] sm:gap-8">
                <h3 className="mk-display text-[1.75rem]">{card.title}</h3>
                <p className={`max-w-[44ch] ${MUTED}`}>{card.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <DimensionLine reference="B" />

        <section aria-labelledby="features-title" className={BAND}>
          <h2 id="features-title" className={H2}>{FEATURES_TITLE}</h2>
          <ol className="mt-10 space-y-16 lg:mt-14 lg:space-y-24">
            {FEATURES.map((feature, index) => {
              const flip = index % 2 === 1;
              return (
                <li key={feature.title} className="grid items-center gap-6 lg:grid-cols-12 lg:gap-0">
                  <div className={`lg:col-span-5 lg:row-start-1 ${flip ? "lg:col-start-8" : "lg:col-start-1"}`}>
                    <div className={`flex items-center ${flip ? "lg:flex-row-reverse" : ""}`}>
                      <span className="mk-balloon" aria-hidden>{index + 1}</span>
                      <span className="mk-leader hidden lg:block" data-to={flip ? "start" : "end"} aria-hidden />
                    </div>
                    <div className={flip ? "lg:pl-12" : "lg:pr-12"}>
                      <h3 className="mk-display mt-5 text-[2rem]">{feature.title}</h3>
                      <p className={`mt-2 max-w-[42ch] ${MUTED}`}>{feature.detail}</p>
                    </div>
                  </div>
                  <div className={`lg:col-span-7 lg:row-start-1 ${flip ? "lg:col-start-1" : "lg:col-start-6"}`}>
                    <FeatureFigure figure={feature.figure} shot={feature.shot} />
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <DimensionLine reference="C" />

        <section aria-labelledby="builder-title" className={`${BAND} grid gap-6 lg:grid-cols-12 lg:gap-10`}>
          <h2 id="builder-title" className={`${H2} lg:col-span-4`}>{FOUNDER_TITLE}</h2>
          <div className="border-l border-[#0b2a5b] pl-5 sm:pl-8 lg:col-span-7 lg:col-start-6">
            <div className="max-w-[40rem] space-y-3 text-[1.25rem] leading-relaxed">
              {FOUNDER_NOTE.map((line) => <p key={line}>{line}</p>)}
            </div>
            {FOUNDER_NAME ? (
              <p className="mt-6 flex items-baseline gap-3">
                <span className="mk-label">{SHEET_LABELS.signed}</span>
                <span className="mk-mono font-medium">{FOUNDER_NAME}</span>
              </p>
            ) : null}
            <p className="mt-6"><a href={FOUNDER_URL} className="mk-link font-semibold">{FOUNDER_LINK_LABEL}</a></p>
          </div>
        </section>

        <DimensionLine reference="D" />

        <div className={`${BAND} grid gap-14 lg:grid-cols-12 lg:gap-10`}>
          <section aria-labelledby="who-title" className="lg:col-span-4">
            <h2 id="who-title" className={H2}>{WHO_TITLE}</h2>
            <p className={`mt-5 max-w-[36ch] text-lg leading-relaxed ${MUTED}`}>{WHO_TEXT}</p>
          </section>
          <section aria-labelledby="start-title" className="lg:col-span-7 lg:col-start-6">
            <h2 id="start-title" className={H2}>{START_TITLE}</h2>
            <div className="mt-6 border border-[#0b2a5b] bg-white">
              <div aria-hidden className="mk-label grid grid-cols-[3.5rem_1fr] border-b border-[#0b2a5b]">
                <span className="border-r border-[#0b2a5b] px-3 py-1.5">{SHEET_LABELS.rev}</span>
                <span className="px-3 py-1.5">{SHEET_LABELS.description}</span>
              </div>
              <ol>
                {START_STEPS.map((step, index) => (
                  <li key={step.title} className="grid grid-cols-[3.5rem_1fr] border-b border-[#0b2a5b]/30 last:border-b-0">
                    <span className="mk-mono border-r border-[#0b2a5b] px-3 py-4 text-lg font-medium">{String.fromCharCode(65 + index)}</span>
                    <div className="px-3 py-4">
                      <h3 className="mk-display text-[1.5rem]">{step.title}</h3>
                      <p className={`mt-1 ${MUTED}`}>{step.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </div>

        <DimensionLine reference="E" />

        <section aria-labelledby="faq-title" className={`${BAND} grid gap-8 lg:grid-cols-12 lg:gap-10`}>
          <h2 id="faq-title" className={`${H2} self-start lg:sticky lg:top-8 lg:col-span-4`}>{FAQ_TITLE}</h2>
          <div className="border-t border-[#0b2a5b] lg:col-span-8">
            {FAQ.map((item) => (
              <details key={item.question} className="border-b border-[#0b2a5b]/30">
                <summary className="mk-display flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 py-3 text-[1.5rem]">
                  <span>{item.question}</span>
                  <span aria-hidden className="mk-plus" />
                </summary>
                <p className={`max-w-[62ch] pb-6 ${MUTED}`}>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="close-title" className={`${SHEET} pb-14 lg:pb-20`}>
          <div className="grid gap-8 border border-[#0b2a5b] bg-white p-6 sm:p-8 lg:grid-cols-12 lg:gap-10 lg:p-12">
            <h2 id="close-title" className="mk-display text-[clamp(2.25rem,4.6vw,3.75rem)] uppercase lg:col-span-7">{CLOSE_TITLE}</h2>
            <div className="self-end lg:col-span-5">
              <p className={`text-lg leading-relaxed ${MUTED}`}>{CLOSE_CALL_LINE}</p>
              <Cta className="mt-6 w-full sm:w-auto" />
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </MarketingSheet>
  );
}
