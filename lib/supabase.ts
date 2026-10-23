import { createBrowserClient } from "@supabase/ssr";

import { pendingEntries } from "@/lib/offline/outbox";
import { offlineScope, suspendOfflineAccess } from "@/lib/offline/scope";
import { classifyAuthRefusal, requestSubject } from "@/lib/session-end";
import { LOCK_NOTICE_KEY } from "@/lib/session-policy";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/**
 * When the server refuses a request because the session has ended (017's request check answers 28000 "Your session has ended"),
 * the device is treated as offline: the queue and copies are KEPT (like the idle lock) and the count of unsynced changes is
 * recorded for the sign-in page. A refusal that says the account is disabled or removed locks cached access without deleting work
 * (lib/session-end.ts). The app's own access recheck is what sends the person to sign in.
 */
export async function sessionEndedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const requestScope = offlineScope();
  const response = await fetch(input, init);
  if (!response.ok && response.status >= 400 && response.status < 500) {
    try {
      const kind = classifyAuthRefusal(response.status, await response.clone().text());
      if (kind === "access-ended") {
        // Fail closed even when no offline scope was in use for the request (the app still loading its profile, or already locked):
        // the person the request was sent as is locked out of cached access, exactly as with a scope. Work stays on the device.
        const refusedUser = requestScope?.userId ?? requestSubject(input, init);
        if (refusedUser) suspendOfflineAccess(refusedUser);
      } else if (kind === "session-ended") await noteSessionEnded();
    } catch {
      // the response stays usable for the caller either way
    }
  }
  return response;
}

/** Records, for the sign-in page, that the session ended and how many offline changes are kept on this device. */
async function noteSessionEnded() {
  if (typeof window === "undefined") return;
  let pending = 0;
  try {
    const scope = offlineScope();
    if (scope) pending = (await pendingEntries(scope)).length;
  } catch {
    // The count is only for the message.
  }
  try {
    window.localStorage.setItem(LOCK_NOTICE_KEY, JSON.stringify({ reason: "ended", pending }));
  } catch {
    // The sign-in page then just shows the plain form.
  }
}

/**
 * supabase-js 2.105 hands auth-js `lockAcquireTimeout: undefined`, which overwrites auth-js's own default of 5000 ms.
 * With no timeout, a tab that holds the shared auth Web Lock (`lock:sb-<ref>-auth-token`) and never lets go (another
 * tab or installed-app window stuck mid-refresh, a frozen tab) makes EVERY query in every other tab wait for it
 * forever: no request is sent and nothing is logged, and reloading doesn't help while that tab lives. Set explicitly,
 * a waiter gives up after 5 s and takes the orphaned lock (auth-js's recovery path), so the queries go out.
 */
export const AUTH_OPTIONS = { lockAcquireTimeout: 5000 } as const;

export const supabase = isSupabaseConfigured
  ? createBrowserClient(supabaseUrl!, supabaseAnonKey!, typeof window === "undefined" ? undefined : { auth: AUTH_OPTIONS, global: { fetch: sessionEndedFetch } })
  : null;

