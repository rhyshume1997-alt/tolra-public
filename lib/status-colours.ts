/**
 * The one status-to-colour map. Every status badge in the app takes its colour and its word from here (StatusBadge), so a
 * status looks the same on every page, in light and dark mode. A badge always carries its word: colour is never the only signal.
 *
 * Colour families (light / dark):
 *   green  #16A34A / #4ADE80  complete, accepted, passed, paid, on time, delivered
 *   yellow #CA8A04 / #FACC15  at risk, waiting for inspection, part paid, conditional supplier, waiting on supplier/customer
 *                             (yellow fill with DARK text, never yellow text on a light page)
 *   red    #DC2626 / #F87171  overdue, blocked supplier, sync failed, failed inspection, a problem reported on a job (117)
 *   blue   #2563EB / #60A5FA  active, running (a job), sent, issued, sync pending
 *   purple #7C3AED / #C4B5FD  rework only (a tag on a Running job, never a status)
 *   grey   #6B7280 / #9CA3AF  draft, not started, archived, void, cancelled
 *
 * A job can show two badges at once (Overdue red + Rework purple); neither hides the other.
 * Tailwind class names are written out in full below so the build finds them.
 */
export type StatusColour = "green" | "yellow" | "red" | "blue" | "purple" | "grey";

export const COLOUR_TOKENS: Record<StatusColour, { light: string; dark: string }> = {
  green: { light: "#16A34A", dark: "#4ADE80" },
  yellow: { light: "#CA8A04", dark: "#FACC15" },
  red: { light: "#DC2626", dark: "#F87171" },
  blue: { light: "#2563EB", dark: "#60A5FA" },
  purple: { light: "#7C3AED", dark: "#C4B5FD" },
  grey: { light: "#6B7280", dark: "#9CA3AF" },
};

/** `badge` is the filled pill (dark text on yellow and green in light mode; dark text on every fill in dark mode); `dot` is the small round marker. */
export const COLOUR_CLASSES: Record<StatusColour, { badge: string; dot: string }> = {
  green: { badge: "bg-[#16A34A] text-slate-950 dark:bg-[#4ADE80] dark:text-slate-950", dot: "bg-[#16A34A] dark:bg-[#4ADE80]" },
  yellow: { badge: "bg-[#CA8A04] text-slate-950 dark:bg-[#FACC15] dark:text-slate-950", dot: "bg-[#CA8A04] dark:bg-[#FACC15]" },
  red: { badge: "bg-[#DC2626] text-white dark:bg-[#F87171] dark:text-slate-950", dot: "bg-[#DC2626] dark:bg-[#F87171]" },
  blue: { badge: "bg-[#2563EB] text-white dark:bg-[#60A5FA] dark:text-slate-950", dot: "bg-[#2563EB] dark:bg-[#60A5FA]" },
  purple: { badge: "bg-[#7C3AED] text-white dark:bg-[#C4B5FD] dark:text-slate-950", dot: "bg-[#7C3AED] dark:bg-[#C4B5FD]" },
  grey: { badge: "bg-[#6B7280] text-white dark:bg-[#9CA3AF] dark:text-slate-950", dot: "bg-[#6B7280] dark:bg-[#9CA3AF]" },
};

export type StatusKey =
  | "complete" | "accepted" | "passed" | "paid" | "on_track" | "delivered"
  | "at_risk" | "awaiting_inspection" | "part_paid" | "conditional_supplier" | "waiting_on_supplier" | "waiting_on_customer"
  | "overdue" | "blocked_supplier" | "sync_failed" | "failed_inspection" | "problem"
  | "active" | "in_progress" | "sent" | "issued" | "sync_pending"
  | "rework"
  | "draft" | "not_started" | "no_due_date" | "archived" | "void" | "cancelled";

export const STATUS_MAP: Record<StatusKey, { label: string; colour: StatusColour }> = {
  complete: { label: "Complete", colour: "green" },
  accepted: { label: "Accepted", colour: "green" },
  passed: { label: "Passed", colour: "green" },
  paid: { label: "Paid", colour: "green" },
  on_track: { label: "On time", colour: "green" },
  delivered: { label: "Delivered", colour: "green" },

  at_risk: { label: "At risk", colour: "yellow" },
  awaiting_inspection: { label: "Waiting for inspection", colour: "yellow" },
  part_paid: { label: "Part paid", colour: "yellow" },
  conditional_supplier: { label: "Conditional supplier", colour: "yellow" },
  waiting_on_supplier: { label: "Waiting on supplier", colour: "yellow" },
  waiting_on_customer: { label: "Waiting on customer", colour: "yellow" },

  overdue: { label: "Overdue", colour: "red" },
  blocked_supplier: { label: "Blocked supplier", colour: "red" },
  sync_failed: { label: "Sync failed", colour: "red" },
  failed_inspection: { label: "Failed inspection", colour: "red" },
  problem: { label: "Problem", colour: "red" },

  active: { label: "Active", colour: "blue" },
  in_progress: { label: "Running", colour: "blue" },
  sent: { label: "Sent", colour: "blue" },
  issued: { label: "Issued", colour: "blue" },
  sync_pending: { label: "Sync pending", colour: "blue" },

  rework: { label: "Rework", colour: "purple" },

  draft: { label: "Draft", colour: "grey" },
  not_started: { label: "Not started", colour: "grey" },
  no_due_date: { label: "No due date", colour: "grey" },
  archived: { label: "Archived", colour: "grey" },
  void: { label: "Void", colour: "grey" },
  cancelled: { label: "Cancelled", colour: "grey" },
};

export const statusColourClasses = (status: StatusKey) => COLOUR_CLASSES[STATUS_MAP[status].colour];

/* Where a page's own status words land on the map. null: the word is not one of the agreed statuses, so the page keeps its existing look. */
const lower = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

export function quoteStatusKey(status: string | null | undefined): StatusKey | null {
  return ({ draft: "draft", sent: "sent", accepted: "accepted" } as Record<string, StatusKey>)[lower(status)] ?? null;
}

export function salesOrderStatusKey(status: string | null | undefined): StatusKey | null {
  return ({ open: "active", confirmed: "accepted", despatched: "sent" } as Record<string, StatusKey>)[lower(status)] ?? null;
}

export function purchaseOrderStatusKey(status: string | null | undefined): StatusKey | null {
  return ({ draft: "draft", issued: "issued", sent: "sent", awaiting: "waiting_on_supplier", received: "delivered", cancelled: "cancelled" } as Record<string, StatusKey>)[lower(status)] ?? null;
}

export function deliveryNoteStatusKey(status: string | null | undefined): StatusKey | null {
  return ({ draft: "draft", pending: "not_started", despatched: "sent", delivered: "delivered", signed: "delivered" } as Record<string, StatusKey>)[lower(status)] ?? null;
}

export function emailStatusKey(status: string | null | undefined): StatusKey | null {
  return ({ drafted: "draft", sent_manually: "sent", sent_via_system: "sent" } as Record<string, StatusKey>)[lower(status)] ?? null;
}

/**
 * The badge for an invoice row (list and details). Paid green, part paid yellow, past due red, otherwise issued blue; a closed
 * invoice shows what it is (draft, void, cancelled in grey). A credited invoice and "payment to confirm" are not agreed statuses (null).
 */
export function invoiceStatusKey(invoice: { status: string; rawStatus: string; partPaid: boolean; daysOverdue: number }): StatusKey | null {
  if (invoice.status === "paid") return "paid";
  if (invoice.status === "unverified") return null;
  if (invoice.status === "closed") {
    const raw = lower(invoice.rawStatus);
    if (raw === "draft") return "draft";
    if (raw === "void" || raw === "voided") return "void";
    if (raw === "cancelled" || raw === "canceled") return "cancelled";
    return null;
  }
  if (invoice.partPaid) return "part_paid";
  if (invoice.daysOverdue > 0) return "overdue";
  return "issued";
}

/**
 * Machine Schedule blocks and legend, on the same map. Running is "active" (blue), booked is "not started" (grey), complete is
 * green; purple is never used (rework only).
 * DECISION FOR RHYS (not in the agreed map): paused = yellow ("waiting"), free = no fill (a plain slot, not green).
 * Change `paused` or `free` here and the blocks, the legend and the legend sentence all follow.
 */
export type ScheduleState = "free" | "booked" | "running" | "paused" | "complete";

export const SCHEDULE_STATES: Record<ScheduleState, { label: string; status: StatusKey | null }> = {
  free: { label: "Free", status: null },
  booked: { label: "Booked", status: "not_started" },
  running: { label: "Running", status: "active" },
  paused: { label: "Paused", status: "waiting_on_supplier" },
  complete: { label: "Complete", status: "complete" },
};

/** The legend order, left to right. */
export const SCHEDULE_ORDER: ScheduleState[] = ["free", "booked", "running", "paused", "complete"];

/** The colour a state draws in (null: no fill). */
export const scheduleColour = (state: ScheduleState): StatusColour | null => {
  const status = SCHEDULE_STATES[state].status;
  return status ? STATUS_MAP[status].colour : null;
};

/** Classes for a block (fill and its readable text colour); a free slot has the plain fill. */
export const SCHEDULE_FREE_FILL = "bg-white dark:bg-transparent";
export const scheduleBlockClass = (state: ScheduleState): string => {
  const colour = scheduleColour(state);
  return colour ? COLOUR_CLASSES[colour].badge : SCHEDULE_FREE_FILL;
};

/** The legend sentence under the timeline title, built from the map so it cannot drift: "No fill is free, grey is booked, ...". */
export function scheduleLegendText(): string {
  const parts = SCHEDULE_ORDER.map((state) => {
    const colour = scheduleColour(state);
    return `${colour ?? "no fill"} is ${SCHEDULE_STATES[state].label.toLowerCase()}`;
  });
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
