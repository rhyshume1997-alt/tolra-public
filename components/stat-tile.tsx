import Link from "next/link";

import { COLOUR_CLASSES } from "@/lib/status-colours";
import { cn } from "@/lib/utils";

/** "rework" is its own purple, so an In rework tile is never mistaken for Overdue ("bad", red). */
export type StatTone = "neutral" | "good" | "warn" | "bad" | "info" | "rework";

export const DOT: Record<StatTone, string> = {
  neutral: "bg-ink/25",
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: COLOUR_CLASSES.red.dot,
  rework: COLOUR_CLASSES.purple.dot,
  info: "bg-brand-accent",
};

/**
 * One headline number: mono label, large figure, one line of context. Colour is a small dot, not a tinted card,
 * so a page of stats stays calm and the numbers carry the weight.
 */
export function StatTile({ label, value, sub, hint, tone = "neutral", href, onClick, active, className, valueClassName, labelClassName }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** The full definition behind the number, shown on hover, so the line under the figure can stay short. */
  hint?: string;
  tone?: StatTone;
  href?: string;
  /** Makes the tile a button (e.g. "filter the list below by this"). */
  onClick?: () => void;
  active?: boolean;
  className?: string;
  valueClassName?: string;
  /** Extra classes for the label row (the Job Board passes BOARD_KPI_LABEL: a fixed two-line label row). */
  labelClassName?: string;
}) {
  const body = (
    <div title={hint} className={cn("group h-full rounded-xl border border-line bg-surface px-5 py-5 text-left transition-colors", (href || onClick) && "hover:border-ink/20", active && "border-brand-accent/50 ring-1 ring-brand-accent/30", className)}>
      <p data-kpi-label="" className={cn("label-mono field-label flex items-center gap-2", labelClassName)}>
        <span className={cn("size-1.5 rounded-full", DOT[tone])} aria-hidden />
        {label}
      </p>
      <p data-kpi-value="" className={cn("mt-4 text-[2rem] font-semibold leading-none tracking-tight tabular-nums text-ink", valueClassName)}>{value}</p>
      {sub ? <p className="mt-2 text-sm text-muted-foreground">{sub}</p> : null}
    </div>
  );
  if (onClick) {
    return <button type="button" onClick={onClick} aria-pressed={active} className="block h-full w-full rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-accent/30">{body}</button>;
  }
  return href ? <Link href={href} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-accent/30">{body}</Link> : body;
}

/** Maps the old accent classes (border-l-red-500 etc.) to a tone. */
export function toneFromAccent(accent?: string): StatTone {
  if (!accent) return "info";
  if (accent.includes("red")) return "bad";
  if (accent.includes("amber") || accent.includes("orange") || accent.includes("yellow")) return "warn";
  if (accent.includes("green") || accent.includes("emerald")) return "good";
  if (accent.includes("blue")) return "info";
  return "neutral";
}
