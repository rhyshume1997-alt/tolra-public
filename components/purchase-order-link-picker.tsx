"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { LINK_PICKER_LIMIT, type LinkTarget, findLinkTargets, linkKey, linkLabel } from "@/lib/purchase-order-link";
import { supabase } from "@/lib/supabase";

/**
 * "For quote / job (optional)" on a supplier purchase order (migration 124): a search box (quote or job number, or customer, searched in
 * the database, newest first) and the list it finds, quotes then jobs. The chosen one stays in the list while the search changes, as the
 * job picker (components/job-picker.tsx) does. Internal only: never on the supplier's PDF.
 */
export function PurchaseOrderLinkPicker({ selected, active, onPick, className }: {
  selected: LinkTarget | null;
  /** Load only while the form is open. */
  active: boolean;
  onPick: (target: LinkTarget | null) => void;
  className?: string;
}) {
  const [term, setTerm] = useState("");
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!supabase || !active) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void findLinkTargets(supabase as never, term).then((found) => {
        if (!current) return;
        setTargets(found.targets);
        setTruncated(found.truncated);
        setFailed(found.failed);
      });
    }, term ? 250 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [active, term]);

  const options = selected && !targets.some((t) => linkKey(t) === linkKey(selected)) ? [selected, ...targets] : targets;
  return (
    <div className="grid gap-1">
      <Input aria-label="Search quotes and jobs" placeholder="Search by quote or job number, or customer" value={term} onChange={(event) => setTerm(event.target.value)} className="h-9" />
      <select
        aria-label="For quote / job"
        data-testid="po-link-picker"
        value={selected ? linkKey(selected) : ""}
        onChange={(event) => onPick(options.find((t) => linkKey(t) === event.target.value) ?? null)}
        className={className ?? "h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"}
      >
        <option value="">{failed ? "Couldn't load the quotes and jobs" : "Not for a particular quote or job"}</option>
        {options.map((t) => <option key={linkKey(t)} value={linkKey(t)}>{linkLabel(t)}</option>)}
      </select>
      {truncated ? <p className="text-xs text-slate-500">Showing the newest {LINK_PICKER_LIMIT} quotes and jobs. Type a number or customer to find an older one.</p> : null}
    </div>
  );
}
