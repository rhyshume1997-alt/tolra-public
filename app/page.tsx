import type { Metadata } from "next";

import { BracketT } from "@/components/marketing/bracket-t";
import { Cta } from "@/components/marketing/cta";
import { FeatureBlocks } from "@/components/marketing/feature-blocks";
import { GearWorkflow } from "@/components/marketing/gear-workflow";
import { JobCardCompact } from "@/components/marketing/job-card-compact";
import { JobFlow } from "@/components/marketing/job-flow";
import { MeetTooly } from "@/components/marketing/meet-tooly";
import { OnePlace } from "@/components/marketing/one-place";
import { MarketingSheet } from "@/components/marketing/sheet";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { ToolyGuide } from "@/components/marketing/tooly-guide";
import { ToolyGuideProvider } from "@/components/marketing/tooly-guide-state";
import { ToolyMark } from "@/components/marketing/tooly-mark";
import { ToolyMenu } from "@/components/marketing/tooly-menu";
import {
  CLOSE_CALL_LINE, CLOSE_TITLE, FAQ, FAQ_TITLE, FEATURES, FEATURES_TITLE, FOUNDER_LINK_LABEL, FOUNDER_NAME, FOUNDER_NOTE, FOUNDER_TITLE, FOUNDER_URL,
  HANDLES_TITLE, HERO_SUBHEAD, HERO_TITLE, MARKETING_ICONS, PAIN_CARDS, PAIN_TITLE, PROOF_LINE, SEE_HOW_LABEL, SHEET_LABELS, SITE_DESCRIPTION,
  SITE_TITLE, SITE_URL, START_STEPS, START_TITLE, TRUST_ITEMS, WHO_TEXT, WHO_TITLE, jsonLd,
} from "@/lib/marketing";
import { GEAR_COPY } from "@/lib/marketing/gear-workflow";

// Inputs: the copy and links in lib/marketing.ts. Output: the public home page ("/"): hero with the job traveller, "Everything in one place",
// problems and the gear workflow, what it does, Meet Tooly, founder, who it is for, getting started, questions and the close.
// Must not change: every claim in lib/marketing.ts, the one h1, the booking link on every call to action, the Screenshot / Illustration labels,
// the JSON-LD, and middleware.ts (signed-in people never see this page: it sends them to /dashboard).
// Tooly as a living guide (components/marketing/tooly-*.tsx): a "Job stages" menu in the header and a fixed Tooly with a caption for each section,
// found by the section ids below (so keep every section's aria-labelledby id). Both render nothing until the page has mounted; both are off for
// reduced motion apart from a still Tooly and the same captions; "Hide Tooly" removes him for the session.
// "How Tolra handles it" shows the gear workflow (components/marketing/gear-workflow.tsx); its copy lives in lib/marketing/gear-workflow.ts.
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
 * clamp(56px, 8vw, 112px). Order: hero (white), everything in one place (blue), problems and answers (white), what it does (blue),
 * Meet Tooly (white), founder (blue), who and getting started (white), questions (blue), close (white).
 */
const BAND = "mk-band";
const BAND_ALT = "mk-band mk-band-alt";
const H1 = "mk-display text-[clamp(2.75rem,6.2vw,5rem)] uppercase";
const H2 = "mk-display text-[clamp(2.25rem,4.4vw,3.5rem)] uppercase";
const MUTED = "text-[#3c5277]";

export default function Home() {
  return (
    <MarketingSheet>
      <ToolyGuideProvider>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()).replace(/</g, "\\u003c") }} />

      <SiteHeader menu={<ToolyMenu />} />

      <main id="main" className="flex-1">
        {/*
          The sheet's first view: what Tolra is and the booking link on the left, one job on its traveller on the right. On a phone the
          traveller comes after the notes, so a short picture of it (JobCardCompact) sits right under the subhead.
        */}
        <section aria-labelledby="hero-title" className={`${BAND} mk-hero`}>
          <div className={`${SHEET} grid gap-12 lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-10 lg:gap-y-10`}>
            <div className="lg:col-span-7 lg:col-start-1 lg:row-start-1 lg:pr-6">
              <h1 id="hero-title" className={H1}>{HERO_TITLE}</h1>
              <p className={`mt-6 max-w-[34rem] text-lg leading-relaxed ${MUTED}`}>{HERO_SUBHEAD}</p>
              <JobCardCompact className="mt-6" />
              <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
                <Cta />
                <a href="#flow-title" className="mk-link inline-flex min-h-11 items-center text-base font-semibold lg:hidden">{SEE_HOW_LABEL}</a>
              </div>
              {/* No static Tooly here: the one Tooly on the page is the animated guide (components/marketing/tooly-guide.tsx), who drops in at the top right. */}
            </div>
            <div className="lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1">
              <JobFlow />
            </div>
            {/* The only proof the page makes, with the three checked trust items, as one rule. On a phone it follows the traveller; on a large screen it
                sits directly under the call to action, so the first screen is text, button and proof beside the traveller, with no empty block where the static Tooly was. */}
            <div className="flex flex-col gap-y-3 border-t border-[#0b2a5b] pt-4 lg:col-span-7 lg:col-start-1 lg:row-start-2 lg:self-start">
              <p className="font-semibold">{PROOF_LINE}</p>
              <ul className="mk-label flex flex-wrap gap-x-6 gap-y-1">
                {TRUST_ITEMS.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="one-place-title" className={BAND_ALT}>
          <div className={SHEET}><OnePlace /></div>
        </section>

        {/* The problems, then the drawings that answer them, in one section: each drawing pairs "Today: ..." with "In Tolra: ...". */}
        <section aria-labelledby="pain-title" className={BAND}>
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
              <p className={`self-end lg:col-span-4 lg:col-start-9 ${MUTED}`}>{GEAR_COPY.hint}</p>
            </div>
            <div className="mt-8 lg:mt-12">
              <GearWorkflow />
            </div>
          </div>
        </section>

        <section aria-labelledby="features-title" className={BAND_ALT}>
          <div className={SHEET}>
            <h2 id="features-title" className={H2}>{FEATURES_TITLE}</h2>
            {/* The Job Board as a wide lead, then the features in varied compositions (components/marketing/feature-blocks.tsx). */}
            <FeatureBlocks />
          </div>
        </section>

        <section aria-labelledby="tooly-title" className={BAND}>
          <div className={SHEET}><MeetTooly /></div>
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
                <div className="mt-8 flex items-end gap-6">
                  <BracketT size={56} bracket="#0b2a5b" ink="#0b2a5b" />
                  <ToolyMark size={112} />
                </div>
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
      <ToolyGuide />
      </ToolyGuideProvider>
    </MarketingSheet>
  );
}
