import type { Metadata } from "next";

import { BracketT } from "@/components/marketing/bracket-t";
import { Cta } from "@/components/marketing/cta";
import { FeatureFigure, ScreenFigure } from "@/components/marketing/feature-figure";
import { JobCardCompact } from "@/components/marketing/job-card-compact";
import { JobFlow } from "@/components/marketing/job-flow";
import { MarketingSheet } from "@/components/marketing/sheet";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import InkOrbitFeatures from "@/components/ui/ink-orbit-features";
import {
  CLOSE_CALL_LINE, CLOSE_TITLE, FAQ, FAQ_TITLE, FEATURES, FEATURES_TITLE, FOUNDER_LINK_LABEL, FOUNDER_NAME, FOUNDER_NOTE, FOUNDER_TITLE, FOUNDER_URL,
  HANDLES_HINT, HANDLES_TITLE, HERO_SUBHEAD, HERO_TITLE, MARKETING_ICONS, PAIN_CARDS, PAIN_TITLE, PROOF_LINE, SCREENSHOTS, SEE_HOW_LABEL, SHEET_LABELS, SITE_DESCRIPTION,
  SITE_TITLE, SITE_URL, START_STEPS, START_TITLE, TRUST_ITEMS, WHO_TEXT, WHO_TITLE, jsonLd,
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

/** The sheet's column: one width and one gutter for every band, so the rules line up down the page. */
const SHEET = "mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-10";
/**
 * A section: a full-width band, white and pale blue in turn (marketing.css .mk-band / .mk-band-alt), with one vertical padding,
 * clamp(56px, 8vw, 112px). Order: hero (white), problems and answers (blue), what it does (white), founder (blue),
 * who and getting started (white), questions (blue), close (white).
 */
const BAND = "mk-band";
const BAND_ALT = "mk-band mk-band-alt";
const H1 = "mk-display text-[clamp(2.5rem,4.8vw,4rem)] uppercase";
const H2 = "mk-display text-[clamp(2rem,3.6vw,3rem)] uppercase";
const MUTED = "text-[#3c5277]";

export default function Home() {
  return (
    <MarketingSheet>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()).replace(/</g, "\\u003c") }} />

      <SiteHeader />

      <main id="main" className="flex-1">
        {/*
          The sheet's first view: what Tolra is and the booking link on the left, one job on its traveller on the right. On a phone the
          traveller comes after the notes, so a short picture of it (JobCardCompact) sits right under the subhead.
        */}
        <section aria-labelledby="hero-title" className={`${BAND} mk-hero`}>
          <div className={`${SHEET} grid gap-12 lg:grid-cols-12 lg:gap-10`}>
            <div className="lg:col-span-7 lg:pr-6">
              <h1 id="hero-title" className={H1}>{HERO_TITLE}</h1>
              <p className={`mt-6 max-w-[34rem] text-lg leading-relaxed ${MUTED}`}>{HERO_SUBHEAD}</p>
              <JobCardCompact className="mt-6" />
              <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
                <Cta />
                <a href="#flow-title" className="mk-link inline-flex min-h-11 items-center text-base font-semibold lg:hidden">{SEE_HOW_LABEL}</a>
              </div>
              <div className="mt-12 max-w-[34rem] border-t border-[#0b2a5b] pt-3">
                <p className="mk-label">{SHEET_LABELS.notes}</p>
                <ol className="mk-notes mt-2 space-y-1.5 text-[0.9375rem]">
                  {[PROOF_LINE, ...TRUST_ITEMS].map((note, index) => (
                    <li key={note} className={index === 0 ? "font-semibold" : ""}>{note}</li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="lg:col-span-5">
              <JobFlow />
            </div>
          </div>
        </section>

        {/* The problems, then the drawings that answer them, in one section: each drawing pairs "Today: ..." with "In Tolra: ...". */}
        <section aria-labelledby="pain-title" className={BAND_ALT}>
          <div className={SHEET}>
            <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
              <h2 id="pain-title" className={`${H2} self-start lg:sticky lg:top-8 lg:col-span-4`}>{PAIN_TITLE}</h2>
              <ul className="border-t border-[#0b2a5b] lg:col-span-8">
                {PAIN_CARDS.map((card) => (
                  <li key={card.title} className="grid gap-2 border-b border-[#0b2a5b]/30 py-5 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] sm:gap-8">
                    <h3 className="mk-display text-[1.625rem]">{card.title}</h3>
                    <p className={`max-w-[52ch] ${MUTED}`}>{card.detail}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-[clamp(48px,6vw,80px)] grid gap-3 border-t border-[#0b2a5b] pt-6 lg:grid-cols-12 lg:gap-10">
              <h3 id="handles-title" className="mk-display text-[clamp(1.75rem,2.8vw,2.375rem)] uppercase lg:col-span-7">{HANDLES_TITLE}</h3>
              <p className={`self-end lg:col-span-4 lg:col-start-9 ${MUTED}`}>{HANDLES_HINT}</p>
            </div>
            <div className="mt-8 lg:mt-12">
              <InkOrbitFeatures />
            </div>
          </div>
        </section>

        <section aria-labelledby="features-title" className={BAND}>
          <div className={SHEET}>
            <h2 id="features-title" className={H2}>{FEATURES_TITLE}</h2>
            {/* Two real screens from the app (redacted to example names), framed like the drawings; each opens full size on a tap. */}
            <div className="mt-10 grid gap-8 lg:mt-14 lg:grid-cols-2 lg:gap-10">
              {SCREENSHOTS.map((shot) => <ScreenFigure key={shot.src} shot={shot} />)}
            </div>
            <ol className="mt-16 space-y-16 lg:mt-24 lg:space-y-24">
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
          </div>
        </section>

        <section aria-labelledby="builder-title" className={BAND_ALT}>
          <div className={`${SHEET} grid gap-6 lg:grid-cols-12 lg:gap-10`}>
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
              <p className="mt-6"><a href={FOUNDER_URL} className="mk-link inline-flex min-h-11 items-center font-semibold">{FOUNDER_LINK_LABEL}</a></p>
            </div>
          </div>
        </section>

        <div className={BAND}>
          <div className={`${SHEET} grid gap-14 lg:grid-cols-12 lg:gap-10`}>
            <section aria-labelledby="who-title" className="lg:col-span-4">
              <h2 id="who-title" className={H2}>{WHO_TITLE}</h2>
              <p className={`mt-5 max-w-[36ch] text-lg leading-relaxed ${MUTED}`}>{WHO_TEXT}</p>
            </section>
            <section aria-labelledby="start-title" className="lg:col-span-7 lg:col-start-6">
              <h2 id="start-title" className={H2}>{START_TITLE}</h2>
              <div className="mt-6 border border-[#0b2a5b] bg-white">
                <div aria-hidden className="mk-label grid grid-cols-[3.5rem_1fr] border-b border-[#0b2a5b]">
                  <span className="border-r border-[#0b2a5b] px-4 py-2">{SHEET_LABELS.rev}</span>
                  <span className="px-4 py-2">{SHEET_LABELS.description}</span>
                </div>
                <ol>
                  {START_STEPS.map((step, index) => (
                    <li key={step.title} className="grid grid-cols-[3.5rem_1fr] border-b border-[#0b2a5b]/30 last:border-b-0">
                      <span className="mk-mono border-r border-[#0b2a5b] px-4 py-4 text-lg font-medium">{String.fromCharCode(65 + index)}</span>
                      <div className="px-4 py-4">
                        <h3 className="mk-display text-[1.5rem]">{step.title}</h3>
                        <p className={`mt-1 max-w-[60ch] ${MUTED}`}>{step.detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          </div>
        </div>

        <section aria-labelledby="faq-title" className={BAND_ALT}>
          <div className={`${SHEET} grid gap-8 lg:grid-cols-12 lg:gap-10`}>
            <h2 id="faq-title" className={`${H2} self-start lg:sticky lg:top-8 lg:col-span-4`}>{FAQ_TITLE}</h2>
            <div className="border-t border-[#0b2a5b] lg:col-span-8">
              {FAQ.map((item) => (
                <details key={item.question} className="border-b border-[#0b2a5b]/30">
                  <summary className="mk-display flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 py-4 text-[1.5rem]">
                    <span>{item.question}</span>
                    <span aria-hidden className="mk-plus" />
                  </summary>
                  <p className={`max-w-[62ch] pb-6 ${MUTED}`}>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="close-title" className={BAND}>
          <div className={SHEET}>
            <div className="grid gap-8 border border-[#0b2a5b] bg-white p-6 sm:p-8 lg:grid-cols-12 lg:gap-10 lg:p-12">
              <div className="lg:col-span-7">
                <h2 id="close-title" className="mk-display text-[clamp(2rem,3.8vw,3.25rem)] uppercase">{CLOSE_TITLE}</h2>
                <BracketT size={56} bracket="#0b2a5b" ink="#0b2a5b" className="mt-8" />
              </div>
              <div className="self-end lg:col-span-5">
                <p className={`text-lg leading-relaxed ${MUTED}`}>{CLOSE_CALL_LINE}</p>
                <Cta className="mt-6 w-full sm:w-auto" />
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </MarketingSheet>
  );
}
