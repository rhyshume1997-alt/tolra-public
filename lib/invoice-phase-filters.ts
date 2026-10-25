/**
 * The Invoices list has two filters that both narrow it: the Show tab (Open / Done / Archived / All) and the status chips (Overdue,
 * Outstanding, Part paid, Paid, Draft / void). A chip that can't match anything in the chosen tab empties the list ("Open" + "Paid":
 * paid invoices are Done), so switching tab drops those chips. Which statuses sit in which tab follows lib/archive phaseOf: only a paid
 * invoice is Done; Open is everything else not archived; Archived and All can hold any status, so they keep the chips.
 */
export type InvoicePhase = "open" | "done" | "archived" | "all";

const CHIPS_IN_PHASE: Partial<Record<InvoicePhase, ReadonlySet<string>>> = {
  open: new Set(["overdue", "outstanding", "partial", "closed", "unverified"]),
  done: new Set(["paid"]),
};

/** The chips to keep for `phase`: those that can still show something there, or just "all" when none can. */
export function chipsForPhase(chips: ReadonlySet<string>, phase: InvoicePhase): Set<string> {
  const allowed = CHIPS_IN_PHASE[phase];
  if (!allowed || chips.has("all")) return new Set(chips);
  const kept = [...chips].filter((chip) => allowed.has(chip));
  return new Set(kept.length ? kept : ["all"]);
}
