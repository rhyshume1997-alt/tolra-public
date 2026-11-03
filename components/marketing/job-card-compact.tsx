import { FLOW_JOB, FLOW_STEPS, FLOW_TITLE, ILLUSTRATION_LABEL, SHEET_LABELS } from "@/lib/marketing";

const ROW = "grid grid-cols-[3.25rem_1fr_7.25rem] items-center";

/**
 * The traveller in short, for phones only (hidden from 640px): its header and the first three stages, already stamped, right under
 * the hero's subhead. It is a picture of the full traveller further down, which is the one people use: this copy has no controls,
 * no ids and no motion, and is hidden from assistive tech so nothing is read or tabbed to twice.
 */
export function JobCardCompact({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`border border-[#0b2a5b] bg-white sm:hidden ${className}`}>
      <div className="flex items-start justify-between gap-4 border-b border-[#0b2a5b] px-[var(--mk-box)] py-[var(--mk-box-y)]">
        <p className="mk-display text-[1.375rem] uppercase">{FLOW_TITLE}</p>
        <p className="shrink-0 pt-0.5 text-right">
          <span className="mk-mono block text-base font-medium">{FLOW_JOB.number}</span>
          <span className="mk-label block">{ILLUSTRATION_LABEL}</span>
        </p>
      </div>
      <div className={`mk-label ${ROW} border-b border-[#0b2a5b]/30 py-1.5`}>
        <span className="pl-[var(--mk-box)]">{SHEET_LABELS.op}</span>
        <span>{SHEET_LABELS.stage}</span>
        <span className="pr-[var(--mk-box)] text-right">{SHEET_LABELS.stamp}</span>
      </div>
      {FLOW_STEPS.slice(0, 3).map((s) => (
        <div key={s.id} className={`${ROW} min-h-12 border-b border-[#0b2a5b]/30 last:border-b-0`}>
          <span className="mk-mono pl-[var(--mk-box)] text-sm text-[#3c5277]">{s.op}</span>
          <span className="mk-display text-[1.3125rem]">{s.label}</span>
          <span className="flex justify-end py-1 pr-[var(--mk-box)]">
            <span className="mk-stampbox" data-stamped="true">
              <span className="mk-stamp">
                <span>{s.stamp}</span>
                <span>{s.date}</span>
              </span>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
