import type { InUseRow } from "@/lib/machine-runs";

/** Why the Job Board's machine picker has nothing to offer, and what to tell the person about adding one. */
export type PickerEmpty = {
  code: "loading" | "load_failed" | "none" | "only_this_job" | "all_busy";
  reason: string;
  /** "link": admin or office with the Schedule page open to them. "ask": workshop (or anyone who cannot add one). null: no further line. */
  next: "link" | "ask" | null;
};

/**
 * Nothing to pick in the machine picker (plan Bug 5): no machines at all, the read failed, the job is already on every machine, or every
 * other machine is in use by another job (an admin may take one over, so that case never applies to an admin). Null when something can
 * be ticked. While the job is not running the bench is always a choice, so only "no machines" and a failed read are reported then.
 * `loading`: the machine list is still being read, so an empty list means "not yet", never "No machines set up yet".
 * `canAdd`: the person may add a machine and the Machine Schedule page is open to them (admin or office, section not hidden).
 */
export function pickerEmptyReason(
  machines: { id: string; name: string }[],
  inUse: Map<string, InUseRow>,
  role: string | null | undefined,
  jobId: string,
  loadFailed: boolean,
  opts: { running?: boolean; canAdd?: boolean; loading?: boolean } = {},
): PickerEmpty | null {
  const next: PickerEmpty["next"] = opts.canAdd ? "link" : role === "workshop" ? "ask" : null;
  if (machines.length === 0) {
    if (opts.loading && !loadFailed) return { code: "loading", reason: "Loading machines…", next: null };
    return loadFailed
      ? { code: "load_failed", reason: "Couldn't load the machines. Reload and try again.", next: null }
      : { code: "none", reason: "No machines set up yet.", next };
  }
  if (!opts.running) return null;
  const isAdmin = role === "admin";
  const mine = (id: string) => inUse.get(id)?.job_id === jobId;
  const pickable = machines.filter((m) => !mine(m.id) && (isAdmin || !inUse.has(m.id)));
  if (pickable.length > 0) return null;
  const onThisJob = machines.filter((m) => mine(m.id));
  if (onThisJob.length === machines.length) {
    return { code: "only_this_job", reason: machines.length === 1 ? `${machines[0].name} is the only machine, and this job is already on it.` : "This job is already on every machine.", next };
  }
  return { code: "all_busy", reason: "Every other machine is in use by another job.", next };
}
