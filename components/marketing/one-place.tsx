import { ScreenFigure } from "@/components/marketing/feature-figure";
import { ONE_PLACE_ITEMS, ONE_PLACE_NOTE, ONE_PLACE_TITLE, POSITIONING_LINE, SCREENSHOTS } from "@/lib/marketing";

// Inputs: the copy in lib/marketing.ts (ONE_PLACE_*, POSITIONING_LINE) and the first real screen in SCREENSHOTS (the dashboard).
// Output: the "Everything in one place" section: the positioning line, four short points, and the dashboard as the lead figure.
// Must not change: every point restates what the real screens already show; no new feature, number or claim. The figure keeps its
// Screenshot label (ScreenFigure) so the page's labelling rules and tests hold.

/** The page's lead after the hero: one sentence of positioning, the dashboard at full width, and four numbered points under it. */
export function OnePlace() {
  const lead = SCREENSHOTS[0];
  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-12 lg:gap-10">
        <h2 id="one-place-title" className="mk-display text-[clamp(2.25rem,4.4vw,3.5rem)] uppercase lg:col-span-4">{ONE_PLACE_TITLE}</h2>
        <p className="text-[clamp(1.375rem,2.2vw,1.875rem)] font-semibold leading-snug lg:col-span-7 lg:col-start-6">{POSITIONING_LINE}</p>
      </div>
      <div className="mk-reveal mt-10 lg:mt-14">
        <ScreenFigure shot={lead} />
        <p className="mk-label mt-3">{ONE_PLACE_NOTE}</p>
      </div>
      <ol className="mt-12 grid gap-x-10 gap-y-8 border-t border-[#0b2a5b] pt-8 sm:grid-cols-2 lg:mt-16 lg:grid-cols-4 lg:gap-x-8">
        {ONE_PLACE_ITEMS.map((item, index) => (
          <li key={item.title} className="mk-reveal flex gap-4 lg:block">
            <span className="mk-balloon" aria-hidden>{index + 1}</span>
            <div>
              <h3 className="mk-display text-[1.75rem] lg:mt-5">{item.title}</h3>
              <p className="mt-2 text-[#3c5277]">{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
