/**
 * The owner's Overview: the "leaks" row at the top of the admin Dashboard. Each leak is one count from the Needs attention rules
 * (lib/attention-items) or the Dashboard's own figures, so the row and the list below it can never disagree. The sections' own figures
 * (attentionSummary, revenueVsLastMonth, fleetLoad) follow the same rule: each is worked out from rows a panel already shows, and a
 * figure whose read failed or is still loading is a dash with the reason, never a reassuring 0.
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
  /** Red word next to the count when there is any (Late). */
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

function sectionLeak(sections: AttentionSection[] | null, id: AttentionRuleId, label: string, action: string, empty: string, alarm?: string, listFailed = false): Leak | null {
  // The whole list couldn't be read: every leak that comes from it says so (never dropped, never 0).
  if (listFailed) return { id, label, count: null, detail: "Couldn't load this.", action, href: "#", failed: true };
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
 * `sections` is the admin's Needs attention result (null while it loads); `listFailed` is true when that read failed.
 */
export function leaksFrom(sections: AttentionSection[] | null, figures: Figures, listFailed = false): Leak[] {
  const leaks: Array<Leak | null> = [
    sectionLeak(sections, "quotes-no-decision", "Quotes with no reply", "Chase them", "Every sent quote has an answer.", undefined, listFailed),
    {
      id: "rfqs-to-quote",
      label: "Enquiries not quoted",
      count: figures.rfqsToQuote,
      detail: figures.rfqsToQuote === 0 ? "Every RFQ has a quote." : "RFQs with no quote yet",
      action: "Quote them",
      href: "/rfq",
      failed: false,
    },
    sectionLeak(sections, "jobs-late", "Jobs running late", "See why", "Nothing is late.", "Late", listFailed),
    sectionLeak(sections, "jobs-inspection", "Waiting to be checked", "Open inspection", "Nothing waiting for inspection.", undefined, listFailed),
    (() => {
      // The rule id stays "invoices-overdue"; the words say Late, as everywhere else on the Overview.
      const leak = sectionLeak(sections, "invoices-overdue", "Money late", "Chase payment", "Nothing late.", "Late", listFailed);
      if (leak && figures.overdueOwed !== null && figures.overdueOwed > 0) leak.extra = figures.money(figures.overdueOwed);
      return leak;
    })(),
  ];
  return leaks.filter((l): l is Leak => l !== null);
}

/** Why a figure has no number yet: shown beside the dash, so a dash is never read as "nothing". */
const LOADING = "Loading…";
const FAILED = "Couldn't load this.";

export type AttentionSummary = {
  /** Everything on the Needs attention list; null while loading or when any read behind the list failed. */
  total: number | null;
  /** Of those, the jobs past their required date and the invoices past their due date (the two leaks with the red word Late). */
  urgent: number | null;
  detail: string;
  failed: boolean;
};

/**
 * The Today heading's figure: how many things need the owner, and how many of them are late. The same sum the Needs attention card
 * counts (lib/attention-load: quotes, rfqs, purchase_orders, jobs, invoices, delivery_notes, jobs_awaiting_despatch_or_invoice()),
 * plus the Dashboard's own items (`extra`: imported invoices whose payment is to confirm, from invoices). Any part missing is a dash.
 * The leaks row shows four of those rules as tiles; otherAttention() lists the rest under it, so everything counted here is on screen.
 */
export function attentionSummary(sections: AttentionSection[] | null, extra: { count: number | null; failed: boolean }, listFailed = false): AttentionSummary {
  if (listFailed || extra.failed || sections?.some((s) => s.failed)) return { total: null, urgent: null, detail: FAILED, failed: true };
  if (!sections || extra.count === null) return { total: null, urgent: null, detail: LOADING, failed: false };
  const total = sections.reduce((sum, s) => sum + s.count, 0) + extra.count;
  const urgent = (fromSection(sections, "jobs-late")?.count ?? 0) + (fromSection(sections, "invoices-overdue")?.count ?? 0);
  if (total === 0) return { total: 0, urgent: 0, detail: "Nothing needs you right now.", failed: false };
  const detail = `${total} thing${total === 1 ? " needs" : "s need"} you, ${urgent > 0 ? `${urgent} late` : "none late"}`;
  return { total, urgent, detail, failed: false };
}

/** The Needs attention rules the leaks row already shows as tiles (rfqs-to-quote is a Dashboard figure, not one of these rules). */
const LEAK_RULES: ReadonlySet<AttentionRuleId> = new Set(["quotes-no-decision", "jobs-late", "jobs-inspection", "invoices-overdue"]);

/** kind "rule": a Needs attention rule and its count; "item": one Dashboard item (counted once; its title carries its own number). */
export type OtherAttention = { id: string; kind: "rule" | "item"; label: string; count: number; href: string };

/**
 * Everything the Today figure counts that is not a leak tile: the other Needs attention rules with something in them (their own titles,
 * counts and links, from the same sections), and the Dashboard's own items (`extra`, each counted once as attentionSummary and the
 * Needs attention card count them: today only "N imported invoices: payment to confirm", from invoices). The four leak tiles' counts
 * plus these add up to the Today figure exactly. null while loading or when any part failed (the Today figure is a dash then too).
 */
export function otherAttention(sections: AttentionSection[] | null, extra: { items: Array<{ key: string; title: string; href: string }> | null; failed: boolean }, listFailed = false): OtherAttention[] | null {
  if (listFailed || extra.failed || !sections || !extra.items || sections.some((s) => s.failed)) return null;
  const rows: OtherAttention[] = sections
    .filter((s) => !LEAK_RULES.has(s.id) && s.count > 0)
    .map((s) => ({ id: s.id, kind: "rule" as const, label: s.title, count: s.count, href: s.href }));
  for (const item of extra.items) rows.push({ id: item.key, kind: "item", label: item.title, count: 1, href: item.href });
  return rows;
}

export type RevenueCompare = { previous: number | null; change: number | null; detail: string; failed: boolean };

/**
 * This month so far against all of last month: the last two points of the Revenue panel's chosen series (received: the Dashboard's six
 * months from invoice_payments, by the date received; invoiced: issued invoices ex VAT less credit notes, lib/overview-metrics), so the
 * tile, the line and this comparison are one read. `change` is null when last month had nothing to compare with (nothing received or
 * invoiced, or netted below zero).
 */
export function revenueVsLastMonth(revenue: Array<{ month: string; revenue: number }> | null, loading: boolean, money: (value: number) => string, verb: "received" | "invoiced" = "received"): RevenueCompare {
  if (loading) return { previous: null, change: null, detail: LOADING, failed: false };
  if (!revenue || revenue.length < 2) return { previous: null, change: null, detail: FAILED, failed: true };
  const { revenue: current } = revenue[revenue.length - 1];
  const { month, revenue: previous } = revenue[revenue.length - 2];
  if (previous === 0) return { previous, change: null, detail: `Nothing ${verb} in ${month}`, failed: false };
  // Reversals are negative payment rows, so a month can net below zero; a percentage of that would flip its sign.
  if (previous < 0) return { previous, change: null, detail: `${month} netted below zero`, failed: false };
  let change = Math.round(((current - previous) / previous) * 100);
  if (change === -100 && current > 0) change = -99; // something was received, so never "100% below"
  const detail = change === 0 ? `So far level with ${month} (${money(previous)})` : `So far ${Math.abs(change)}% ${change > 0 ? "above" : "below"} ${month} (${money(previous)})`;
  return { previous, change, detail, failed: false };
}

export type FleetLoad = { percent: number | null; free: number | null; detail: string; failed: boolean };

/**
 * All machines together this week: hours booked of the hours they are set to work, and the hours still free (an overbooked machine
 * frees nothing on another). Worked out from the Machine load panel's own rows (lib/dashboard-analytics machineLoad over machines and
 * machine_bookings), so the overall figure and the bars always agree.
 */
export function fleetLoad(machines: Array<{ booked: number; available: number }> | null, loading: boolean): FleetLoad {
  if (loading) return { percent: null, free: null, detail: LOADING, failed: false };
  if (!machines) return { percent: null, free: null, detail: FAILED, failed: true };
  const available = machines.reduce((sum, m) => sum + m.available, 0);
  if (available <= 0) return { percent: null, free: null, detail: "No machine hours set up.", failed: false };
  // A machine with no working days has no hours to book against, so its bookings stay out of the figure (as on its bar).
  const booked = machines.reduce((sum, m) => sum + (m.available > 0 ? m.booked : 0), 0);
  const percent = Math.round((booked / available) * 100);
  const free = Math.round(machines.reduce((sum, m) => sum + Math.max(0, m.available - m.booked), 0));
  return { percent, free, detail: `${percent}% of available hours booked · ${free}h free`, failed: false };
}

/** The Overview's sections, in page order: the jump links and the section anchors use these ids. */
export const OVERVIEW_SECTIONS = [
  { id: "today", label: "Today" },
  { id: "money", label: "Money" },
  { id: "work", label: "Work" },
  { id: "machines", label: "Machines" },
  { id: "people", label: "People" },
] as const;
