/**
 * BOUNDARY (module 1, Auth): the signed-in person's "I finished the first-login admin tour" flag.
 * No database change, no new table. The flag lives in the person's own Supabase auth user_metadata (follows them to any device),
 * with a copy in this browser's localStorage (keyed by user id, so it is fast and still works if the save fails).
 *
 * Inputs: a user id, the user's user_metadata (or null), an optional storage, and for the save a client that has auth.updateUser.
 * Outputs: booleans, and { saved } from the save. Nothing here throws, and nothing here ever shows or starts the tour.
 * The tour itself, its switches (server env flag and company marker) and its screens are NOT in this file.
 *
 * The person can edit their own user_metadata, so this flag is only "do not show the tour again". It is never a permission,
 * never a quiz result and never read by the database. Quiz results need their own table later.
 *
 * Must not change: KEY texts (they are stored in people's accounts), the rule that only admin sees the admin tour, or the rule
 * that a failed save never throws and never blocks the person.
 */

/** user_metadata key. Versioned so a later, different tour can ask again without clearing this one. */
export const TOUR_DONE_META_KEY = "tooly_admin_tour_v1_done";

/** localStorage key prefix; the user id follows it. */
export const TOUR_DONE_COPY_PREFIX = "tolra-tooly-admin-tour-v1-done:";

/** The small part of Storage this file uses (so tests need no browser). */
export type TourStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The small part of the Supabase client the save uses. */
export type TourAuthClient = {
  auth: { updateUser: (attributes: { data: Record<string, unknown> }) => PromiseLike<{ error: unknown }> };
};

const copyKey = (userId: string) => TOUR_DONE_COPY_PREFIX + userId;

function browserStorage(): TourStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Only the admin view gets the admin tour. Workshop, office, viewer and a missing role never do. */
export function canSeeAdminTour(role?: string | null): boolean {
  return role === "admin";
}

/** True only when user_metadata holds exactly `true` under the key. Anything else (missing, "true", 1, an object) is not done. */
export function tourDoneInMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return (metadata as Record<string, unknown>)[TOUR_DONE_META_KEY] === true;
}

/** True when this browser holds a done copy for this user. A storage error counts as not done. */
export function readTourDoneCopy(userId: string, storage: TourStorage | null = browserStorage()): boolean {
  if (!userId || !storage) return false;
  try {
    return storage.getItem(copyKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeTourDoneCopy(userId: string, storage: TourStorage | null): void {
  if (!userId || !storage) return;
  try {
    storage.setItem(copyKey(userId), "1");
  } catch {
    /* storage unavailable: the account copy still counts */
  }
}

/** Done when either the account or this browser says so. No user id means not done (so nothing is ever shown to an unknown person). */
export function isTourDone(userId: string | null | undefined, metadata: unknown, storage: TourStorage | null = browserStorage()): boolean {
  if (!userId) return false;
  return tourDoneInMetadata(metadata) || readTourDoneCopy(userId, storage);
}

/**
 * Marks the tour done for this person. The browser copy is written first, so the tour never repeats on this device even if the
 * account save fails. The account save sends only the one key (Supabase merges it into user_metadata, so full_name and the rest stay).
 * Returns { saved: true } only when the account save was accepted; never throws.
 */
export async function markTourDone(
  client: TourAuthClient | null | undefined,
  userId: string | null | undefined,
  storage: TourStorage | null = browserStorage(),
): Promise<{ saved: boolean }> {
  if (!userId) return { saved: false };
  writeTourDoneCopy(userId, storage);
  if (!client) return { saved: false };
  try {
    const { error } = await client.auth.updateUser({ data: { [TOUR_DONE_META_KEY]: true } });
    return { saved: !error };
  } catch {
    return { saved: false };
  }
}
