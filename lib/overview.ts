/**
 * The owner's Overview: the "leaks" row at the top of the admin Dashboard. Each leak is one count from the Needs attention rules
 * (lib/attention-items) or the Dashboard's own figures, so the row and the list below it can never disagree.
 */
import type { AttentionRuleId, AttentionSection } from "@/lib/attention-items";

export type Leak = {
  id: string;
  label: string;
  /** null while loading or when the read behind it failed (shown as a dash, never as 0). */
  count: number | null;
  /** A second figure beside the count, e.g. the money at stake. */
  extra?: string;
  /** One line: the oldest item, or what the count means. */
  detail: string;
  /** What the link does, in words. */
  action: string;
  href: string;
  /** Red word next to the count when there is any (late, overdue). */
  alarm?: string;
  failed: boolean;
};

type Figures = {
  /** RFQs with no quote yet (the Dashboard's rfqFigures().outstanding); null while loading or failed. */
  rfqsToQuote: number | null;
  /** £ past its due date (owedByAge, everything but "not due"); null while loading or failed. */
  overdueOwed: number | null;
  /** Formats money the way the rest of the Dashboard does. */
  money: (value: number) => string;
};

const fromSection = (sections: AttentionSection[] | null, id: AttentionRuleId) => sections?.find((s) => s.id === id) ?? null;

function sectionLeak(sections: AttentionSection[] | null, id: AttentionRuleId, label: string, action: string, empty: string, alarm?: string): Leak | null {
  const sec = fromSection(sections, id);
  if (sections && !sec) return null; // not one of this role's rules
  const count = sec && !sec.failed ? sec.count : null;
  const oldest = sec?.items[0];
  return {
    id,
    label,
    count,
    detail: sec?.failed ? "Couldn't load this." : oldest ? oldest.detail : count === 0 ? empty : "",
    action,
    href: sec?.href ?? "#",
    alarm: count ? alarm : undefined,
    failed: Boolean(sec?.failed),
  };
}

/**
 * The five leaks, in the order an owner reads them: work not yet won, work late, work not checked, money not in.
 * `sections` is the admin's Needs attention result (null while it loads).
 */
export function leaksFrom(sections: AttentionSection[] | null, figures: Figures): Leak[] {
  const leaks: Array<Leak | null> = [
    sectionLeak(sections, "quotes-no-decision", "Quotes with no reply", "Chase them", "Every sent quote has an answer."),
    {
      id: "rfqs-to-quote",
      label: "Enquiries not quoted",
      count: figures.rfqsToQuote,
      detail: figures.rfqsToQuote === 0 ? "Every RFQ has a quote." : "RFQs with no quote yet",
      action: "Quote them",
      href: "/rfq",
      failed: false,
    },
    sectionLeak(sections, "jobs-late", "Jobs running late", "See why", "Nothing is late.", "Late"),
    sectionLeak(sections, "jobs-inspection", "Waiting to be checked", "Open inspection", "Nothing waiting for inspection."),
    (() => {
      const leak = sectionLeak(sections, "invoices-overdue", "Money overdue", "Chase payment", "Nothing overdue.", "Overdue");
      if (leak && figures.overdueOwed !== null && figures.overdueOwed > 0) leak.extra = figures.money(figures.overdueOwed);
      return leak;
    })(),
  ];
  return leaks.filter((l): l is Leak => l !== null);
}

/** The Overview's sections, in page order: the jump links and the section anchors use these ids. */
export const OVERVIEW_SECTIONS = [
  { id: "today", label: "Today" },
  { id: "money", label: "Money" },
  { id: "work", label: "Work" },
  { id: "machines", label: "Machines" },
  { id: "people", label: "People" },
] as const;
