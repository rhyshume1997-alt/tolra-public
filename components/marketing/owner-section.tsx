import { ScreenFigure } from "@/components/marketing/feature-figure";
import { OWNER_FROM, OWNER_LEAD, OWNER_ROWS, OWNER_SHEET, OWNER_TITLE, OWNER_XERO, SCREENSHOTS } from "@/lib/marketing";

const MUTED = "text-[#3c5277]";

/**
 * The owner's section: what the owner and the admin see, drawn as one more sheet. A ruled listing with the place in the app in mono on
 * the left and what you see there on the right (lib/marketing OWNER_ROWS, each checked against main), beside the real Dashboard screen,
 * labelled Example data. It names what is measured and never shows a value.
 */
export function OwnerSection({ className = "" }: { className?: string }) {
  const dashboard = SCREENSHOTS.find((shot) => shot.title === "Dashboard");
  return (
    <section aria-labelledby="owner-title" className={className}>
      <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-10">
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-10">
          <h2 id="owner-title" className="mk-display text-[clamp(2rem,3.6vw,3rem)] uppercase lg:col-span-7">{OWNER_TITLE}</h2>
          <div className="space-y-3 self-end lg:col-span-4 lg:col-start-9">
            <p className="text-[1.25rem] leading-snug">{OWNER_LEAD}</p>
            <p className="font-semibold">{OWNER_XERO}</p>
            <p className={MUTED}>{OWNER_FROM}</p>
          </div>
        </div>

        <div className="mt-10 grid items-start gap-10 lg:mt-14 lg:grid-cols-12 lg:gap-10">
          <div className="border border-[#0b2a5b] bg-white lg:col-span-7">
            <div aria-hidden className="mk-label grid border-b border-[#0b2a5b] sm:grid-cols-[8.5rem_minmax(0,1fr)_auto]">
              <span className="hidden border-r border-[#0b2a5b] px-[var(--mk-box)] py-2 sm:block">{OWNER_SHEET.where}</span>
              <span className="hidden px-[var(--mk-box)] py-2 sm:block">{OWNER_SHEET.what}</span>
              <span className="px-[var(--mk-box)] py-2 !text-[#0b2a5b] sm:text-right">{OWNER_SHEET.title}</span>
            </div>
            {OWNER_ROWS.map((row) => (
              <div key={row.where} className="grid border-b border-[#0b2a5b]/30 last:border-b-0 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
                <h3 className="mk-label border-b border-[#0b2a5b]/30 bg-[#f3f6fa] px-[var(--mk-box)] py-2 !text-[#0b2a5b] sm:border-b-0 sm:border-r sm:border-[#0b2a5b] sm:bg-transparent sm:py-3.5">
                  {row.where}
                </h3>
                <dl className="divide-y divide-[#0b2a5b]/15">
                  {row.items.map(([name, what]) => (
                    <div key={name} className="grid gap-x-6 gap-y-0.5 px-[var(--mk-box)] py-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
                      <dt className="mk-display text-[1.3125rem] leading-tight">{name}</dt>
                      <dd className={`text-[0.9375rem] leading-snug ${MUTED}`}>{what}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          {dashboard ? (
            <div className="order-first lg:sticky lg:top-8 lg:order-none lg:col-span-5">
              <ScreenFigure shot={dashboard} sizes="(min-width: 1240px) 465px, (min-width: 1024px) 38vw, calc(100vw - 2rem)" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
