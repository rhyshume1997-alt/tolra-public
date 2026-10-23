/**
 * Admin > Users: reading who may record inspections, and saving an Edit that changes both the member (PATCH /api/admin/users) and the
 * inspector flag (set_member_inspector). The two writes are separate, so the order and the message must say exactly what was applied.
 */

/** The inspector flags read from organization_members: the set of user ids, or null when the read failed (so nothing is guessed). */
export function inspectorFlags(data: unknown, error: unknown): Set<string> | null {
  if (error || !Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const row of data) {
    if (row && typeof row === "object" && (row as { can_inspect?: unknown }).can_inspect === true) {
      const id = (row as { user_id?: unknown }).user_id;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return ids;
}

/** What PATCH /api/admin/users can change, one write each, in the order the server applies them. */
export type PatchStep = "access" | "username" | "name";
const STEP_LABEL: Record<PatchStep, string> = { access: "role and page access", username: "username", name: "display name" };
const isStep = (value: unknown): value is PatchStep => value === "access" || value === "username" || value === "name";

/**
 * An API refusal. `applied` lists the writes that did succeed before it (the server reports them), `failed` the one that did not, and
 * `uncertain` the ones whose outcome could not be confirmed. A step is in at most one of the three.
 */
export class ApiError extends Error {
  constructor(message: string, readonly applied: PatchStep[] = [], readonly failed: PatchStep | null = null, readonly uncertain: PatchStep[] = []) {
    super(message);
    this.name = "ApiError";
  }
}

/** Reads `applied` / `failed` / `uncertain` from an error response body (ignores anything unexpected; a step is kept in one list only). */
export function apiErrorFrom(body: unknown, fallback: string): ApiError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; applied?: unknown; failed?: unknown; uncertain?: unknown };
  const uncertain = Array.isArray(b.uncertain) ? b.uncertain.filter(isStep) : [];
  const failed = isStep(b.failed) && !uncertain.includes(b.failed) ? b.failed : null;
  const applied = (Array.isArray(b.applied) ? b.applied.filter(isStep) : []).filter((step) => step !== failed && !uncertain.includes(step));
  return new ApiError(typeof b.error === "string" && b.error ? b.error : fallback, applied, failed, uncertain);
}

/**
 * "Saved: display name. Not saved: username – why. May not have saved (reload to check): role and page access." Null when the server
 * reported nothing applied and nothing uncertain.
 */
export function describePartial(err: unknown, why: string): string | null {
  if (!(err instanceof ApiError) || (!err.applied.length && !err.uncertain.length)) return null;
  const parts: string[] = [];
  if (err.applied.length) parts.push(`Saved: ${err.applied.map((step) => STEP_LABEL[step]).join(" and ")}.`);
  if (err.failed) parts.push(`Not saved: ${STEP_LABEL[err.failed]} – ${why}`);
  else if (!err.uncertain.length) parts.push(`Not everything was saved: ${why}`);
  if (err.uncertain.length) parts.push(`${err.uncertain.map((step) => STEP_LABEL[step]).join(" and ")} may not have saved: reload to check.`);
  return parts.join(" ");
}

export type EditSaveResult =
  | { status: "ok" }
  /** Nothing was applied (the member update failed, so the inspector change was not attempted). */
  | { status: "failed"; message: string }
  /** The member details were saved but the inspector change was not. */
  | { status: "partial"; message: string };

/**
 * Save an Edit: the member update first, then the inspector change. If the update fails nothing else runs; if the inspector change fails
 * after the update succeeded, the result says the details were saved and the inspector setting was not.
 */
export async function saveMemberEdit(opts: {
  hasPatch: boolean;
  inspectorChange: boolean | null;
  patch: () => Promise<unknown>;
  setInspector: (value: boolean) => Promise<unknown>;
  describe: (err: unknown) => string;
}): Promise<EditSaveResult> {
  if (opts.hasPatch) {
    try {
      await opts.patch();
    } catch (err) {
      const why = opts.describe(err);
      // Part of the update may have been applied before it failed: say exactly which, never "nothing was changed".
      const partial = describePartial(err, why);
      if (partial) return { status: "partial", message: opts.inspectorChange === null ? partial : `${partial} Who can record inspections was not changed.` };
      return { status: "failed", message: opts.inspectorChange === null ? why : `${why} Nothing was changed, including who can record inspections.` };
    }
  }
  if (opts.inspectorChange !== null) {
    try {
      await opts.setInspector(opts.inspectorChange);
    } catch (err) {
      const why = opts.describe(err);
      return opts.hasPatch
        ? { status: "partial", message: `Their details were saved, but "Can record inspections" was not changed: ${why}` }
        : { status: "failed", message: `"Can record inspections" was not changed: ${why}` };
    }
  }
  return { status: "ok" };
}
