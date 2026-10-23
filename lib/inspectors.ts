/**
 * The authorised inspectors list (ISO 9001 7.2, migration 083). The list is the company's members with
 * organization_members.can_inspect on; only they record an inspection pass or co-sign as the inspector (enforced in the database,
 * offline replays included). Admins add and remove people with set_authorised_inspector, giving a reason; every change, by any
 * path, is a row of inspector_authorisations (never changed or removed). Hidden until the database has 083 (databaseHas083).
 */
import { featurePresent } from "@/lib/db-features";
import { supabase } from "@/lib/supabase";

export const REASON_MIN = 10;
export const REASON_MAX = 500;
export const SCOPE_MAX = 200;

export type InspectorChange = {
  id: string;
  user_id: string;
  change: "added" | "removed";
  scope: string | null;
  reason: string;
  changed_by: string | null;
  changed_at: string;
};

/** People who can be on the list: active admin, office or workshop members (not Tolra support). */
export type InspectorCandidate = { id: string; name: string; roles: string[]; active: boolean; support: boolean; inspector: boolean };

export function eligible(person: InspectorCandidate): boolean {
  return person.active && !person.support && person.roles.some((role) => role === "admin" || role === "office" || role === "workshop");
}

/** What is wrong with a reason or scope as typed (null when it can be sent). Same limits as set_authorised_inspector. */
export function reasonProblem(reason: string): string | null {
  const text = reason.trim();
  if (text.length < REASON_MIN) return `Give the reason (at least ${REASON_MIN} characters), for example the training or experience it rests on.`;
  if (text.length > REASON_MAX) return `The reason is up to ${REASON_MAX} characters.`;
  return null;
}
export function scopeProblem(scope: string): string | null {
  return scope.trim().length > SCOPE_MAX ? `The scope is up to ${SCOPE_MAX} characters.` : null;
}

/** The newest "added" row per person still on the list: since when, what scope, and why. */
export function currentAuthorisations(history: InspectorChange[], onList: ReadonlySet<string>): Map<string, InspectorChange> {
  const latest = new Map<string, InspectorChange>();
  for (const row of [...history].sort((a, b) => (a.changed_at < b.changed_at ? -1 : a.changed_at > b.changed_at ? 1 : 0))) {
    if (row.change === "added") latest.set(row.user_id, row);
    else latest.delete(row.user_id);
  }
  for (const id of [...latest.keys()]) if (!onList.has(id)) latest.delete(id);
  return latest;
}

export async function loadInspectorHistory(): Promise<InspectorChange[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("inspector_authorisations").select("id, user_id, change, scope, reason, changed_by, changed_at")
    .order("changed_at", { ascending: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as InspectorChange[];
}

export async function setAuthorisedInspector(userId: string, authorised: boolean, reason: string, scope = ""): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("set_authorised_inspector", { p_user: userId, p_authorised: authorised, p_scope: scope.trim() || null, p_reason: reason.trim() });
  if (error) throw error;
}

/** Does the database have 083? A GET of at most one history row (any role may ask; row rules may give none). */
let cached083: boolean | null = null;
let pending083: Promise<boolean> | null = null;
export async function databaseHas083(): Promise<boolean> {
  if (cached083 !== null) return cached083;
  if (!supabase) return false;
  pending083 ??= (async () => {
    try {
      const present = featurePresent(await supabase!.from("inspector_authorisations").select("id").limit(1));
      if (present !== null) cached083 = present;
      return present ?? false;
    } catch {
      return false;
    } finally {
      pending083 = null;
    }
  })();
  return pending083;
}
export function resetDatabaseHas083() {
  cached083 = null;
  pending083 = null;
}
