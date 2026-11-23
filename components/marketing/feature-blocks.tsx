import { FeatureFigure, ScreenFigure } from "@/components/marketing/feature-figure";
import { FEATURES, SCREENSHOTS } from "@/lib/marketing";

// Inputs: FEATURES and SCREENSHOTS from lib/marketing.ts (the Job Board is the second screen).
// Output: the "What it does" body: the Job Board as a wide lead, then the features in varied compositions (a wide lead feature, then two
// side by side). The optional AI helper, the last feature, is shown in "Meet Tooly" (meet-tooly.tsx), with its drawn draft quote.
// Must not change: feature order and wording, one figure per feature, the Screenshot / Illustration labels (FeatureFigure, ScreenFigure),
// and that the AI helper stays shown as optional and off until an admin switches it on (its copy in Meet Tooly says so).

const MUTED = "text-[#3c5277]";
type Feature = (typeof FEATURES)[number];

function Heading({ n, feature }: { n: number; feature: Feature }) {
  return (
    <>
      <span className="mk-balloon" aria-hidden>{n}</span>
      <h3 className="mk-display mt-5 text-[2rem]">{feature.title}</h3>
      <p className={`mt-2 max-w-[42ch] ${MUTED}`}>{feature.detail}</p>
    </>
  );
}

export function FeatureBlocks() {
  const board = SCREENSHOTS[1];
  const [lead, second, third] = FEATURES;
  return (
    <div className="mt-10 space-y-16 lg:mt-14 lg:space-y-24">
      <div className="mk-reveal"><ScreenFigure shot={board} /></div>

      {/* Lead feature: the figure wide, the words beside it. */}
      <article className="mk-reveal grid items-center gap-6 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-4"><Heading n={1} feature={lead} /></div>
        <div className="lg:col-span-8"><FeatureFigure figure={lead.figure} shot={lead.shot} /></div>
      </article>

      {/* Two features side by side, words above the figure. */}
      <div className="grid gap-16 lg:grid-cols-2 lg:gap-10">
        {[second, third].map((feature, i) => (
          <article key={feature.title} className="mk-reveal flex flex-col gap-6">
            <div><Heading n={i + 2} feature={feature} /></div>
            <div className="mt-auto"><FeatureFigure figure={feature.figure} shot={feature.shot} /></div>
          </article>
        ))}
      </div>
    </div>
  );
}
