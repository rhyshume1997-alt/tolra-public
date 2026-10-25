import type { UserResponse } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";

/**
 * One auth-server confirmation of the signed-in user, shared by the reads of one page load (page-load lag, step 1).
 *
 * Every supabase-js auth.getUser holds the client's auth lock for a round trip to the auth server, and every database request waits
 * on that lock: a page load asked it about five times in a row. Here:
 *  - a FRESH ask (no maxAgeMs: the sign-in load, the access recheck) always sends its own getUser, exactly as before; its answer is
 *    kept as the latest confirmation;
 *  - a caller that only needs to know who is signed in (it then reads the database, where RLS and 017's session check decide) passes
 *    maxAgeMs and may be answered by a confirmation the auth server gave less than maxAgeMs ago, or join one already in flight, but
 *    ONLY while this device's stored session still names that same user (signed out here or in another tab: no stored session, so
 *    it asks the auth server again);
 *  - only a successful answer naming a user is kept; an error, no user or a thrown request is never kept or reused;
 *  - invalidateConfirmedUser (sign-out, company switch, access ended) drops it: no answer from before is reused or joined after it.
 * Nothing here grants access: it only avoids asking the auth server again for an answer it gave seconds ago.
 */
export const CONFIRMED_USER_REUSE_MS = 10_000;

export type ConfirmedUserSource = {
  /** The auth server's answer (supabase.auth.getUser). */
  getUser: () => Promise<UserResponse>;
  /** The user this device's stored session names now, without asking the auth server (supabase.auth.getSession); null when none. */
  sessionUserId: () => Promise<string | null>;
};

export function createConfirmedUser(source: ConfirmedUserSource, now: () => number = Date.now) {
  let generation = 0;
  let inFlight: { gen: number; promise: Promise<UserResponse> } | null = null;
  let confirmed: { gen: number; at: number; userId: string; answer: UserResponse } | null = null;

  function send(): Promise<UserResponse> {
    const gen = generation;
    // Timed from when the request is sent, not when it is answered: the reuse window never stretches past maxAgeMs of the ask.
    const sentAt = now();
    const promise = Promise.resolve()
      .then(() => source.getUser())
      .then((answer) => {
        const user = answer.data.user;
        if (gen === generation && !answer.error && user) confirmed = { gen, at: sentAt, userId: user.id, answer };
        return answer;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { gen, promise };
    return promise;
  }

  async function reusable(maxAgeMs: number): Promise<UserResponse | null> {
    const kept = confirmed;
    if (!kept || kept.gen !== generation || now() - kept.at >= maxAgeMs) return null;
    let stored: string | null = null;
    try {
      stored = await source.sessionUserId();
    } catch {
      return null;
    }
    // Invalidated while the stored session was read, or the device's session now names someone else (or no one): ask again.
    if (confirmed !== kept || kept.gen !== generation || stored !== kept.userId) return null;
    return kept.answer;
  }

  /** The auth server's answer about the signed-in user. With maxAgeMs, a confirmation that recent (same stored user) may answer. */
  async function confirmedUser(options: { maxAgeMs?: number } = {}): Promise<UserResponse> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    if (maxAgeMs <= 0) return send();
    const kept = await reusable(maxAgeMs);
    if (kept) return kept;
    // A request already on its way (sent after the last invalidation) answers this caller too.
    if (inFlight && inFlight.gen === generation) return inFlight.promise;
    return send();
  }

  /** Sign-out, company switch, access ended: nothing confirmed or in flight before this is reused or joined after it. */
  function invalidate() {
    generation += 1;
    confirmed = null;
    inFlight = null;
  }

  return { confirmedUser, invalidate };
}

const shared = createConfirmedUser({
  getUser: () => {
    if (!supabase) throw new Error("Supabase is not configured.");
    return supabase.auth.getUser();
  },
  sessionUserId: async () => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  },
});

export const confirmedUser = shared.confirmedUser;
export const invalidateConfirmedUser = shared.invalidate;
