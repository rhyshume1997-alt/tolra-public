import Image from "next/image";

import { DEMO_DATA_LABEL, ILLUSTRATION_LABEL, SHEET_LABELS, type FeatureFigure as Figure, type FeatureShot } from "@/lib/marketing";

function KeyValues({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="text-[0.8125rem]">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] border-b border-[#0b2a5b]/25 last:border-b-0">
          <dt className="border-r border-[#0b2a5b]/25 px-2 py-1 text-[#3c5277]">{label}</dt>
          <dd className="mk-mono break-words px-2 py-1 font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The drawing of one layout, from the field names the app prints, with example values. */
function Drawing({ figure }: { figure: Figure }) {
  switch (figure.kind) {
    case "document":
      return (
        <div className="p-4 sm:p-5">
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="mk-display text-lg">{figure.company}</p>
              <div className="mt-2 border border-[#0b2a5b]/60"><KeyValues rows={figure.keyValues} /></div>
            </div>
            <div className="flex items-end justify-between gap-3 sm:block sm:text-right">
              <p className="mk-display text-[2rem] uppercase leading-none">{figure.title}</p>
              <p className="mk-label mt-2 inline-grid h-12 w-20 place-items-center border border-dashed border-[#0b2a5b]/50">{SHEET_LABELS.yourLogo}</p>
            </div>
          </div>
          <div className="mt-4 overflow-hidden border border-[#0b2a5b]/60 text-[0.8125rem]">
            <div className="mk-label grid grid-cols-[minmax(0,1fr)_2rem_2.25rem_2.5rem_2.5rem] sm:grid-cols-[minmax(0,1fr)_2.25rem_2.5rem_2.75rem_2.75rem] border-b border-[#0b2a5b]/60 bg-[#f3f6fa]">
              {figure.columns.map((column, index) => <span key={column} className={`px-1 py-1 tracking-[0.02em] sm:px-2 ${index ? "text-right" : ""}`}>{column}</span>)}
            </div>
            {figure.lines.map((line, row) => (
              <div key={row} className="grid min-h-7 grid-cols-[minmax(0,1fr)_2rem_2.25rem_2.5rem_2.5rem] sm:grid-cols-[minmax(0,1fr)_2.25rem_2.5rem_2.75rem_2.75rem] border-b border-[#0b2a5b]/20 last:border-b-0">
                {line.map((cell, index) => <span key={index} className={`px-1 py-1 sm:px-2 ${index ? "mk-mono text-right" : ""}`}>{cell}</span>)}
              </div>
            ))}
            <div className="h-10" />
          </div>
        </div>
      );
    case "worksheet":
      return (
        <div className="p-4 sm:p-5">
          <div className="flex items-end justify-between gap-3 border-b border-[#0b2a5b] pb-2">
            <p className="mk-display text-lg uppercase">{figure.title}</p>
            <p className="text-[0.8125rem] font-semibold">{SHEET_LABELS.jobNo} <span className="mk-mono ml-1 border-b border-[#0b2a5b] px-2">{figure.jobNo}</span></p>
          </div>
          <div className="mt-3 border border-[#0b2a5b]/60"><KeyValues rows={figure.fields} /></div>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="mk-label">{figure.signOff}</p>
            <span className="h-8 flex-1 border-b border-[#0b2a5b]" />
          </div>
        </div>
      );
    case "schedule": {
      const span = figure.days.length;
      return (
        <div className="p-4 sm:p-5">
          <div className="grid grid-cols-[4.75rem_1fr] text-[0.8125rem] sm:grid-cols-[5.5rem_1fr]">
            <span />
            <div className="mk-label grid border-b border-[#0b2a5b]" style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}>
              {figure.days.map((day) => <span key={day} className="border-l border-[#0b2a5b]/25 px-1.5 py-1">{day}</span>)}
            </div>
            {figure.machines.map((machine) => (
              <div key={machine.name} className="contents">
                <span className="flex items-center border-b border-[#0b2a5b]/25 py-2 pr-2 text-[#3c5277]">{machine.name}</span>
                <div className="relative h-11 border-b border-[#0b2a5b]/25">
                  <div aria-hidden className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}>
                    {figure.days.map((day) => <span key={day} className="border-l border-[#0b2a5b]/15" />)}
                  </div>
                  <div className="absolute inset-y-2 left-0 right-0 border border-dashed border-[#0b2a5b]/45" />
                  {machine.bars.map((bar) => (
                    <span
                      key={`${bar.job}-${bar.from}`}
                      className="mk-mono absolute inset-y-2 flex items-center overflow-hidden whitespace-nowrap bg-[#0b2a5b] px-1 text-[0.6875rem] font-medium text-white sm:px-1.5 sm:text-[0.75rem]"
                      style={{ left: `${(bar.from / span) * 100}%`, width: `${((bar.to - bar.from) / span) * 100}%` }}
                    >
                      {bar.job}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mk-label mt-3">{figure.key}</p>
        </div>
      );
    }
    case "draft":
      return (
        <div className="p-4 sm:p-5">
          <p className="mk-display text-lg">{figure.title}</p>
          <div className="mt-3 border border-[#0b2a5b]/60"><KeyValues rows={figure.fields} /></div>
          <p className="mt-3 inline-block border border-[#0b2a5b] px-2 py-1 text-[0.8125rem] font-semibold">{figure.flag}</p>
        </div>
      );
  }
}

/**
 * One feature's figure. A real screenshot (a seeded demo company) when `shot` is set, labelled Demo data; until then the drawn layout,
 * labelled Illustration. Either way the frame and caption are the same, so screenshots drop in without changing the row.
 */
export function FeatureFigure({ figure, shot }: { figure: Figure; shot: FeatureShot }) {
  return (
    <figure className="border border-[#0b2a5b] bg-white">
      {shot ? <Image src={shot.src} alt={shot.alt} width={shot.width} height={shot.height} sizes="(min-width: 1024px) 640px, 100vw" className="h-auto w-full" /> : <Drawing figure={figure} />}
      <figcaption className="flex items-baseline justify-between gap-3 border-t border-[#0b2a5b] px-3 py-2 text-sm text-[#3c5277]">
        <span>{figure.caption}</span>
        <span className="mk-label shrink-0 text-[#0b2a5b]">{shot ? DEMO_DATA_LABEL : ILLUSTRATION_LABEL}</span>
      </figcaption>
    </figure>
  );
}
