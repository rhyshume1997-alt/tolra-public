import type { Metadata } from "next";
import Image from "next/image";

import { Cta } from "@/components/marketing/cta";
import { JobFlow } from "@/components/marketing/job-flow";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import {
  CLOSE_CALL_LINE, CLOSE_TITLE, FAQ, FAQ_TITLE, FEATURES, FOUNDER_NAME, FOUNDER_URL, HERO_SUBHEAD, PAIN_CARDS, PAIN_TITLE, PROOF_LINE, SEE_HOW_LABEL,
  MARKETING_ICONS, SITE_DESCRIPTION, SITE_TITLE, SITE_URL, START_STEPS, START_TITLE, TRUST_ITEMS, WHO_TEXT, WHO_TITLE, jsonLd,
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

const focusDark = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const focusLight = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b5fc4]";

const SHOTS = [
  { src: "/marketing/mock-quote.svg", title: "Quote PDF", alt: "A branded quote PDF with a quote number, customer, line items, VAT and terms. Demo data." },
  { src: "/marketing/mock-worksheet.svg", title: "Job worksheet", alt: "A job worksheet with a drawing, material, a list of operations with machines and status, and a sign-off box. Demo data." },
  { src: "/marketing/mock-schedule.svg", title: "Machine schedule", alt: "A weekly machine schedule showing job bars on each machine and the free slots between them. Demo data." },
];

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()).replace(/</g, "\\u003c") }} />

      <SiteHeader />

        <main id="main">
          <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-gradient-to-b from-[#0b2a5b] to-[#1457b5] text-white">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10"
              style={{
                backgroundImage: "linear-gradient(rgba(255,255,255,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.07) 1px, transparent 1px)",
                backgroundSize: "32px 32px",
              }}
            />
            <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pb-16 pt-8 sm:px-6 md:grid-cols-[1.4fr_1fr] md:pb-24 md:pt-14">
            <div>
              <h1 id="hero-title" className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">Quotes, jobs and invoices for small CNC and fabrication shops</h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-blue-50">{HERO_SUBHEAD}</p>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Cta />
                <a href="#flow-title" className={`inline-flex min-h-12 items-center rounded text-base font-semibold text-white underline underline-offset-4 hover:text-blue-100 ${focusDark}`}>{SEE_HOW_LABEL}</a>
              </div>
            </div>
            <div className="flex justify-center md:justify-end">
              <Image src="/marketing/tolra-logo.png" alt="The Tolra logo: a white T between two blue brackets" width={320} height={320} priority sizes="(min-width: 768px) 320px, 200px" className="h-auto w-52 rounded-3xl shadow-2xl shadow-black/30 md:w-80" />
            </div>
            </div>
          </section>

          <section aria-labelledby="pain-title" className="bg-white py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
              <h2 id="pain-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">{PAIN_TITLE}</h2>
              <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {PAIN_CARDS.map((card) => (
                  <li key={card.title} className="rounded-xl border border-slate-200 border-t-4 border-t-[#1e8fff] bg-slate-50 p-6">
                    <h3 className="text-lg font-bold text-[#0b2a5b]">{card.title}</h3>
                    <p className="mt-2 text-base leading-relaxed text-slate-700">{card.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section aria-labelledby="flow-title" className="scroll-mt-4 bg-slate-50 py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
              <h2 id="flow-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">One job, from enquiry to invoice</h2>
              <p className="mt-3 max-w-2xl text-lg text-slate-700">Step through how a job moves through Tolra. The examples are demo data.</p>
              <div className="mt-8"><JobFlow /></div>
            </div>
          </section>

          <section aria-labelledby="shots-title" className="bg-white py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
              <h2 id="shots-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">What you work with</h2>
              <ul className="mt-8 grid gap-6 md:grid-cols-3">
                {SHOTS.map((shot) => (
                  <li key={shot.src}>
                    <figure className="overflow-hidden rounded-xl border border-slate-300 bg-slate-100 shadow-sm">
                      <Image src={shot.src} alt={shot.alt} width={640} height={440} unoptimized className="h-auto w-full" />
                      <figcaption className="flex items-center justify-between gap-2 border-t border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-[#0b2a5b]">
                        <span>{shot.title}</span>
                        <span className="rounded-full bg-[#0b2a5b] px-2.5 py-0.5 text-xs text-white">Demo data</span>
                      </figcaption>
                    </figure>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section aria-label="Pilot" className="bg-[#0b2a5b] py-12 text-white">
            <p className="mx-auto w-full max-w-4xl px-4 text-center text-xl font-semibold leading-relaxed sm:px-6 md:text-2xl">{PROOF_LINE}</p>
            <ul aria-label="Trust" className="mx-auto mt-6 flex w-full max-w-4xl flex-wrap justify-center gap-x-3 gap-y-2 px-4 sm:px-6">
              {TRUST_ITEMS.map((item) => (
                <li key={item} className="rounded-full border border-white/40 px-4 py-1.5 text-sm font-semibold text-blue-50">{item}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="features-title" className="bg-slate-50 py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
              <h2 id="features-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">What it does</h2>
              <ul className="mt-8 grid gap-5 sm:grid-cols-2">
                {FEATURES.map((feature) => (
                  <li key={feature.title} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                    <h3 className="text-lg font-bold text-[#0b2a5b]">{feature.title}</h3>
                    <p className="mt-2 text-base leading-relaxed text-slate-700">{feature.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section aria-labelledby="who-title" className="bg-white py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
              <h2 id="who-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">{WHO_TITLE}</h2>
              <p className="mt-4 text-lg leading-relaxed text-slate-700">{WHO_TEXT}</p>
            </div>
          </section>

          <section aria-labelledby="start-title" className="bg-slate-50 py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
              <h2 id="start-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">{START_TITLE}</h2>
              <ol className="mt-8 grid gap-5 md:grid-cols-3">
                {START_STEPS.map((step, index) => (
                  <li key={step.title} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                    <span aria-hidden className="grid size-9 place-items-center rounded-full bg-[#0b2a5b] text-base font-bold text-white">{index + 1}</span>
                    <h3 className="mt-4 text-lg font-bold text-[#0b2a5b]">{step.title}</h3>
                    <p className="mt-2 text-base leading-relaxed text-slate-700">{step.detail}</p>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section aria-labelledby="faq-title" className="bg-white py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
              <h2 id="faq-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">{FAQ_TITLE}</h2>
              <div className="mt-8 divide-y divide-slate-200 rounded-xl border border-slate-200">
                {FAQ.map((item) => (
                  <details key={item.question} className="group p-5 open:bg-slate-50">
                    <summary className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded text-lg font-semibold text-[#0b2a5b] [&::-webkit-details-marker]:hidden ${focusLight}`}>
                      <span>{item.question}</span>
                      <span aria-hidden className="text-2xl leading-none text-[#0b5fc4] transition group-open:rotate-45">+</span>
                    </summary>
                    <p className="mt-3 text-base leading-relaxed text-slate-700">{item.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>

          <section aria-labelledby="builder-title" className="bg-slate-50 py-16 text-slate-900 md:py-20">
            <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
              <h2 id="builder-title" className="text-3xl font-bold tracking-tight text-[#0b2a5b]">Built by an engineer in Glasgow</h2>
              <p className="mt-4 text-lg leading-relaxed text-slate-700">I built Tolra because small CNC and fabrication shops deserve software that follows the way they actually work, from the enquiry on the bench to the invoice in the post.</p>
              {FOUNDER_NAME ? <p className="mt-2 text-base font-semibold text-[#0b2a5b]">{FOUNDER_NAME}</p> : null}
              <p className="mt-4"><a href={FOUNDER_URL} className={`rounded text-lg font-semibold text-[#0b5fc4] underline underline-offset-4 hover:text-[#0b2a5b] ${focusLight}`}>More about Tolra and who is behind it</a></p>
            </div>
          </section>

          <section aria-labelledby="close-title" className="bg-gradient-to-br from-[#0b2a5b] to-[#1457b5] py-16 text-center text-white md:py-20">
            <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
              <h2 id="close-title" className="text-3xl font-bold tracking-tight">{CLOSE_TITLE}</h2>
              <div className="mt-8"><Cta /></div>
              <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-blue-50">{CLOSE_CALL_LINE}</p>
            </div>
          </section>
        </main>

      <SiteFooter />
    </>
  );
}
