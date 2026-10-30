"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";

import { LOCK_NOTICE_KEY, forgetLastActive } from "@/lib/session-policy";
import { loadCompanyProfile, resetCompanyProfile } from "@/lib/company";
import { companyChangedElsewhere, listenForTabSignals } from "@/lib/company-sync";
import { displayNameProblem, normaliseDisplayName } from "@/lib/display-name";
import { confirmSignOut, confirmUnsyncedDiscard, keptAfterSwitchMessage, loadOfflineIdentity, offlineScope, queueGrewDuring, reportOffline, saveOfflineIdentity, setOfflineScope, suspendOfflineAccess, unsyncedIds, wipeOfflineData, wipeOfflineScope } from "@/lib/offline/scope";
import { ACCESS_RECHECK_EVERY_MS, askAccess, beginOrganizationSwitch, createRecheckRunner, decideAccess, endOrganizationSwitch, msUntilOfflineExpiry, organizationSwitchInProgress, sessionEnding, syncPassNeedsRecheck } from "@/lib/access-recheck";
import { confirmedUser, invalidateConfirmedUser } from "@/lib/confirmed-user";
import { OfflineIdentityExpiredError, offlineIdentityExpired } from "@/lib/offline/identity-age";
import { pendingEntries, waitForReplayIdle } from "@/lib/offline/outbox";
import { confirmOfflineAccess, OFFLINE_ACCESS_EVENT, sessionGoneReason, signalAccessRecheck } from "@/lib/offline/access";
import { isNetworkError } from "@/lib/offline/store";
import { onSyncComplete, syncNow } from "@/lib/offline/sync";
import { resetOrgSettings } from "@/lib/org-settings";
import { type SessionInfo, offlineCopyAllowed, parseSessionInfo } from "@/lib/session-info";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { UserProfile, UserRole } from "@/types";

const PROFILE_COLUMNS = "id, email, full_name, role, secondary_role, organization_id, organization, workshop_email, active";
const ROLE_KEY = "active-role";

function getAllowedRoles(profile: UserProfile): UserRole[] {
  if (profile.role === "admin") return ["admin", "office", "workshop"];
  return [profile.role, profile.secondary_role].filter(Boolean) as UserRole[];
}

function readStoredRole(): UserRole | null {
  try {
    return window.localStorage.getItem(ROLE_KEY) as UserRole | null;
  } catch {
    return null;
  }
}

function writeStoredRole(role: UserRole | null) {
  try {
    if (role) window.localStorage.setItem(ROLE_KEY, role);
    else window.localStorage.removeItem(ROLE_KEY);
  } catch {
    // Storage unavailable: the in-memory role still works for this page load.
  }
}

export type OrganizationOption = { organization_id: string; name: string; slug: string; role: UserRole; is_current: boolean };

type UserContextValue = {
  user: User | null;
  profile: UserProfile | null;
  /** Organisations this login can work in (active memberships); the current one has is_current = true. */
  organizations: OrganizationOption[];
  /** Makes another organisation current, clears per-organisation caches and reloads the app at the dashboard. */
  /** False when the person chose to stay (unsynced offline changes). */
  switchOrganization: (organizationId: string) => Promise<boolean>;
  loading: boolean;
  error: Error | null;
  /** Always validated against the profile's real roles; never read localStorage directly. */
  activeRole: UserRole;
  setActiveRole: (role: UserRole) => void;
  signOut: () => Promise<void>;
  hasRole: (role: UserRole) => boolean;
  hasAnyRole: (roles: UserRole[]) => boolean;
  /** Sidebar sections an admin hid from this person in the current organisation (Admin > Users > Page access). */
  hiddenSections: string[];
  /** The database's answer about this session's company (migration 036): support, read-only, expiry, platform owner. */
  session: SessionInfo | null;
  /** Saves the signed-in person's own display name (user_profiles.full_name, their own row under RLS). Throws on failure. */
  updateDisplayName: (name: string) => Promise<void>;
};

const UserContext = createContext<UserContextValue | null>(null);

/** Single shared source for the signed-in user: one profile fetch for the whole dashboard. */
/** Removes this browser's Supabase session cookies (sb-<project>-auth-token and its .0/.1 chunks). */
function clearAuthCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0].trim();
    if (/^sb-.+-auth-token(\.\d+)?$/.test(name)) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [hiddenSections, setHiddenSections] = useState<string[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [activeRole, setActiveRoleState] = useState<UserRole>("viewer");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const signOut = useCallback(async () => {
    // Ids read before the person is asked; only these (and only this person's) are removed below. Work queued meanwhile aborts it.
    const confirmedSignOut = await confirmSignOut(syncNow);
    if (!confirmedSignOut) return;
    sessionEnding.value = true;
    // Nothing the auth server confirmed for this sign-in is reused after this point (lib/confirmed-user.ts).
    invalidateConfirmedUser();
    try {
      if (supabase) await supabase.auth.signOut();
    } catch (err) {
      console.error(err);
    }
    // The other open tabs share this session: they check now and go to sign-in, not at their next focus or 10-minute recheck.
    signalAccessRecheck();
    // Offline the server can't be told and supabase-js keeps the session: end it on this device regardless.
    clearAuthCookies();
    forgetLastActive();
    // Nothing from this person stays on the device (lib/offline).
    await wipeOfflineData(confirmedSignOut);
    resetCompanyProfile();
    resetOrgSettings();
    writeStoredRole(null);
    window.location.assign("/login");
  }, []);

  const switchOrganization = useCallback(async (organizationId: string) => {
    if (!supabase) throw new Error("Supabase is not configured.");
    // Read before the person is asked: the switch removes only these. Work queued after (another tab, while the request below is
    // on the wire) was never asked about and is kept under this company (lib/offline/store.ts wipeScope).
    const confirmed = await unsyncedIds(offlineScope());
    if (!(await confirmUnsyncedDiscard("Switching company", syncNow))) return false;
    // From here the server may answer for the new company: a recheck or sync pass must not read that as "moved" and lock the
    // person out (lib/access-recheck.ts beginOrganizationSwitch). Set after the pre-switch sync, which still sends the old
    // company's queue under the unchanged session; set before the request, so every answer naming the new company arrives
    // after it. The reload at /dashboard resets it; a failure ends it here. Other open tabs share the session: the switch is
    // announced to them, and waits until no tab has a request of this company's queue open (they send nothing more once announced).
    const leaving = offlineScope();
    beginOrganizationSwitch(Date.now(), leaving?.orgId ?? null);
    invalidateConfirmedUser();
    try {
      let idle = true;
      // Work queued (or held) in another tab during the wait was never asked about: refuse, the same as the check above.
      if (leaving && (await queueGrewDuring(leaving, async () => { idle = await waitForReplayIdle(leaving); }))) throw new Error("Changes were saved offline in another tab while switching. Check them (Sync now) and try again.");
      if (!idle) throw new Error("Offline changes are still being sent in another tab. Try again in a moment.");
      const { error: switchError } = await supabase.rpc("switch_organization", { p_org: organizationId });
      if (switchError) throw switchError;
      invalidateConfirmedUser();
      // The session is in the new company for every tab: the other open tabs check now and follow (lib/company-sync.ts).
      signalAccessRecheck();
      // Switching away: the previous company's offline copy and the queue the person agreed to remove go from this device.
      const kept = await wipeOfflineScope(offlineScope(), confirmed);
      setOfflineScope(null);
      resetCompanyProfile();
      resetOrgSettings();
      writeStoredRole(null);
      // The server has switched; work queued in another tab meanwhile stays with the previous company, never silently dropped.
      if (kept) window.alert(keptAfterSwitchMessage(kept));
      window.location.assign("/dashboard");
      return true;
    } catch (err) {
      endOrganizationSwitch();
      throw err;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let accessEnded = false;
    // This tab found its session gone and is going to sign-in: it asked the other tabs once and ignores their answers.
    let leaving = false;
    // This tab saw another tab switch company and is going to the dashboard (followCompanySwitch).
    let followed = false;
    let currentUserId: string | null = null;
    let recheck: (() => Promise<void>) | null = null;
    let recheckRunner: { stop: () => void } | null = null;
    let recheckTimer: ReturnType<typeof setInterval> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    // When the server last confirmed this person; the offline clock runs from here, also while the page stays open.
    let confirmedAt: string | null = null;
    // The offline limit passed and the app shows "Connect to sign in again": the next "online" loads for real.
    let expiredLock = false;
    // When the last full server confirmation began (loadUser online, or a recheck pass that read the profile and my_session): a
    // quiet sync pass straight after it does not ask the same three questions again (lib/access-recheck.ts syncPassNeedsRecheck).
    let fullyConfirmedAt: number | null = null;

    /** Locks the open app when the saved identity has passed its offline age (a timer, not only a check at load). */
    function armExpiry(scopeIds: { userId: string; orgId: string }) {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(async () => {
        if (!mounted || accessEnded) return;
        if (!offlineIdentityExpired(confirmedAt)) return armExpiry(scopeIds);
        const pending = (await pendingEntries(scopeIds).catch(() => [])).length;
        if (!mounted || accessEnded) return;
        expiredLock = true;
        setUser(null);
        setProfile(null);
        setError(new OfflineIdentityExpiredError(pending));
      }, msUntilOfflineExpiry(confirmedAt));
    }

    /** The server no longer lets this person in: cached access stops and the app goes to sign-in; pending work stays. */
    async function endAccess(reason: "signed-out" | "disabled" | "removed" | "moved") {
      fullyConfirmedAt = null;
      invalidateConfirmedUser();
      if (sessionEnding.value) return; // the idle lock or a sign-out is already taking the person to the sign-in page
      if (reason === "signed-out") {
        // A session the server ended (lib/supabase.ts noted it and how many changes are kept): the sign-in page says so. The offline
        // queue stays on the device for the same person; disabled or removed access also preserves it behind an access lock (below).
        let ended = false;
        try { ended = JSON.parse(window.localStorage.getItem(LOCK_NOTICE_KEY) || "null")?.reason === "ended"; } catch { /* plain sign-in page */ }
        clearAuthCookies();
        // The other open tabs share this session: ask them to check now, not at their next focus or 10-minute recheck. Each
        // decides from the server's answer (a timeout keeps the queue for the same person; an ended access locks).
        if (!leaving) {
          leaving = true;
          signalAccessRecheck();
        }
        window.location.assign(ended ? "/login?ended=1" : "/login");
        return;
      }
      // Lock synchronously before storage or network work. Pending records and bytes stay scoped on this device.
      accessEnded = true;
      sessionEnding.value = true;
      setUser(null);
      setProfile(null);
      setOrganizations([]);
      setSession(null);
      setHiddenSections([]);
      setActiveRoleState("viewer");
      setOfflineScope(null);
      if (currentUserId) suspendOfflineAccess(currentUserId);
      clearAuthCookies();
      forgetLastActive();
      resetCompanyProfile();
      resetOrgSettings();
      writeStoredRole(null);
      // A slow auth lock must not hold the revoked person on the dashboard.
      void supabase?.auth.signOut({ scope: "local" }).catch(() => undefined);
      window.location.assign("/login?disabled=1");
    }

    /**
     * Asks the server again what this person may do: removed from the company, switched off or given another role. Installed
     * whether the app opened online or offline (from the device's copy), and run every ACCESS_RECHECK_EVERY_MS, on focus,
     * when the page becomes visible, on "online" and after each sync pass. It does not trust navigator.onLine: a browser that
     * never fired "online" may still say offline once the connection is back, so the request itself is the test. A failed
     * request is not an answer (the offline clock decides); the first answer from the server ends or updates access.
     */
    function installRecheck(currentUser: User, start: UserProfile, organizationsForIdentity: unknown, keepCopy = true) {
      const scopeIds = { userId: currentUser.id, orgId: start.organization_id as string };
      let live: UserProfile = start;
      // One pass at a time; asked again while one is in flight, it runs once more when that pass ends (the pass may have read
      // the server before the removal that prompted the ask). A pass that never settles (a request or lock that hangs) no
      // longer silences every later focus, sync, other-tab signal and 10-minute check: after RECHECK_STALL_MS a fresh pass
      // starts (lib/access-recheck.ts createRecheckRunner). A superseded pass may still end access, but applies nothing else.
      recheckRunner?.stop();
      const runner = createRecheckRunner(async (isCurrent) => {
        if (!supabase) return;
        const client = supabase;
        const passStartedAt = Date.now();
        try {
          // A fresh auth-server answer every pass (never a shared one; lib/confirmed-user.ts).
          const read = await askAccess({
            getUser: () => confirmedUser(),
            readProfile: () => client.from("user_profiles").select("active").eq("id", currentUser.id).maybeSingle(),
            readSession: () => client.rpc("my_session"),
          }, currentUser.id);
          // No session (lib/access-recheck.ts askAccess): the device's access-ended mark decides "disabled" or a plain sign-out.
          if (read.kind === "session-gone") {
            if (mounted && !accessEnded) await endAccess(sessionGoneReason(currentUser.id));
            return;
          }
          if (read.kind === "signed-out") {
            if (mounted) await endAccess("signed-out");
            return;
          }
          // A failed read is not an answer: keep what is shown and let the offline clock decide.
          if (read.kind === "no-answer") return;
          const { profileResult, sessionResult } = read;
          const now = parseSessionInfo(sessionResult.data);
          if (!now) return;
          // This page is switching company on purpose: the answer may already name the new one. No answer (no lock, no role
          // update, no offline-clock restart); the reload at /dashboard loads the person and company from the server again.
          if (organizationSwitchInProgress()) return;
          if (companyChangedElsewhere(live.organization_id, now)) {
            if (mounted) followCompanySwitch();
            return;
          }
          const member = now.organization_id === live.organization_id && now.role
            ? { role: now.role as UserRole, secondary_role: (now.secondary_role as UserRole | null) ?? null, active: true, hidden_sections: now.hidden_sections }
            : null;
          const profileNow = profileResult.data ? { active: (profileResult.data as { active: boolean }).active, organization_id: now.organization_id ?? live.organization_id } : null;
          const decision = decideAccess(live, { signedIn: true, profile: profileNow, membership: member });
          if (!mounted || accessEnded) return;
          if (decision.kind === "end") {
            await endAccess(decision.reason);
            return;
          }
          // A newer pass is asking the server: this older answer must not update the role or restart the offline clock.
          if (!isCurrent()) return;
          const hidden = Array.isArray(member?.hidden_sections) ? (member!.hidden_sections as string[]) : [];
          if (decision.kind === "update") {
            live = { ...live, role: decision.role, secondary_role: decision.secondary_role } as UserProfile;
            setProfile(live);
            const stored = readStoredRole();
            const role = stored && getAllowedRoles(live).includes(stored) ? stored : live.role;
            writeStoredRole(role);
            setActiveRoleState(role);
          }
          setHiddenSections(hidden);
          fullyConfirmedAt = passStartedAt;
          if (keepCopy) {
            confirmedAt = new Date().toISOString();
            armExpiry(scopeIds);
            await saveOfflineIdentity(currentUser.id, { profile: live, organizations: organizationsForIdentity, hiddenSections: hidden });
          }
        } catch {
          // Offline or the server is down: the clock keeps running.
        }
      }, { alive: () => mounted });
      recheckRunner = runner;
      recheck = runner.ask;
      if (recheckTimer) clearInterval(recheckTimer);
      recheckTimer = setInterval(() => void recheck?.(), ACCESS_RECHECK_EVERY_MS);
    }

    /**
     * Another tab switched company (the session is in a different company now): this tab leaves the old company's profile and pages
     * the way the picker does, but removes nothing from the device (the switching tab asked the person and wiped what they agreed to),
     * and reloads at the dashboard. A form open here is told by the browser's "leave this page?" prompt, the same as for any reload.
     */
    function followCompanySwitch() {
      if (accessEnded || followed) return;
      followed = true;
      sessionEnding.value = true;
      invalidateConfirmedUser();
      setOfflineScope(null);
      resetCompanyProfile();
      resetOrgSettings();
      writeStoredRole(null);
      window.location.assign("/dashboard");
    }

    let loadingNow = false;
    async function loadUser() {
      loadingNow = true;
      expiredLock = false;
      setLoading(true);
      setError(null);
      try {
        if (!isSupabaseConfigured || !supabase) {
          console.error("Authentication system not available - Supabase not configured");
          setUser(null);
          setProfile(null);
          setActiveRoleState("viewer");
          setError(new Error("Authentication system not available. Please contact support."));
          return;
        }

        const loadStartedAt = Date.now();
        // Always its own auth-server request; the answer is shared with the rest of this page load (lib/confirmed-user.ts).
        const { data: userData, error: userError } = await confirmedUser();
        // "No session" means signed out; anything else (network, server) is an error to show,
        // not a reason to redirect to /login (middleware would bounce straight back).
        if (userError && userError.name !== "AuthSessionMissingError" && userError.status !== 401 && userError.status !== 403) throw userError;
        const currentUser = userData.user;
        currentUserId = currentUser?.id ?? null;
        if (!currentUser) {
          if (mounted) {
            setUser(null);
            setProfile(null);
            setOrganizations([]);
          }
          return;
        }

        const { data: profileData, error: profileError } = await supabase
          .from("user_profiles")
          .select(PROFILE_COLUMNS)
          .eq("id", currentUser.id)
          .single();
        if (profileError) throw profileError;

        if (!mounted || accessEnded) return;
        if ((profileData as unknown as UserProfile).active === false) {
          await endAccess("disabled");
          return;
        }
        const [{ data: orgData, error: orgError }, { data: sessionData, error: sessionError }] = await Promise.all([
          supabase.rpc("my_organizations"),
          supabase.rpc("my_session"),
        ]);
        if (orgError) console.error(orgError);
        if (sessionError) throw sessionError;
        const info = parseSessionInfo(sessionData);
        if (!info) throw new Error("Unable to load your session.");
        if (!mounted || accessEnded) return;
        // No company chosen for this sign-in yet: the platform owner picks one, a person with several companies chooses.
        if (!info.organization_id && (info.platform_admin || info.needs_choice)) {
          window.location.assign(info.platform_admin ? "/platform" : "/choose-company");
          return;
        }
        // The profile row keeps the person's name and status; the company and role come from THIS session's company.
        const nextProfile = {
          ...(profileData as unknown as UserProfile),
          role: (info.role ?? (profileData as unknown as UserProfile).role) as UserRole,
          secondary_role: (info.secondary_role as UserRole | null) ?? null,
          organization_id: info.organization_id,
          organization: info.organization_name,
        } as UserProfile;
        if (!info.organization_id || !info.role) {
          await endAccess("removed");
          return;
        }
        confirmOfflineAccess(currentUser.id);
        const hidden = info.hidden_sections;
        setHiddenSections(hidden);
        setUser(currentUser);
        setProfile(nextProfile);
        setSession(info);
        setOrganizations(orgError ? [] : ((orgData ?? []) as OrganizationOption[]));
        const stored = readStoredRole();
        const nextRole = stored && getAllowedRoles(nextProfile).includes(stored) ? stored : nextProfile.role;
        writeStoredRole(nextRole);
        setActiveRoleState(nextRole);
        // Offline copies are filed under this person + company; the identity lets the workshop pages open offline. A support
        // session keeps nothing on the device.
        if (nextProfile.organization_id) {
          fullyConfirmedAt = loadStartedAt;
          const keepCopy = offlineCopyAllowed(info);
          setOfflineScope({ userId: currentUser.id, orgId: nextProfile.organization_id }, { support: !keepCopy });
          if (keepCopy) {
            const identity = { profile: nextProfile, organizations: orgError ? [] : orgData ?? [], hiddenSections: hidden };
            void saveOfflineIdentity(currentUser.id, identity);
            // Each time the server confirms the person again the offline clock restarts (see lib/offline/identity-age.ts).
            confirmedAt = new Date().toISOString();
            armExpiry({ userId: currentUser.id, orgId: nextProfile.organization_id });
          }
          installRecheck(currentUser, nextProfile, orgError ? [] : orgData ?? [], keepCopy);
        }
      } catch (caught) {
        console.error(caught);
        // Can't reach the server: carry on with this device's copy of the signed-in person (the session stored in
        // the browser + the identity saved on the last successful load). Only for the same user it was saved for.
        if (mounted && !accessEnded && supabase && isNetworkError(caught)) {
          const { data: sessionData } = await supabase.auth.getSession();
          const sessionUser = sessionData.session?.user;
          currentUserId = sessionUser?.id ?? null;
          const identity = sessionUser ? await loadOfflineIdentity(sessionUser.id) : null;
          const cachedProfile = identity?.data.profile as UserProfile | undefined;
          if (sessionUser && cachedProfile?.organization_id && mounted && !accessEnded && offlineIdentityExpired(identity?.syncedAt)) {
            // Too long since the server last confirmed this person: no offline access until they are online again. Their
            // offline changes stay on the device (filed under their user and company) and are sent after that.
            const pending = (await pendingEntries({ userId: sessionUser.id, orgId: cachedProfile.organization_id }).catch(() => [])).length;
            setUser(null);
            setProfile(null);
            setError(new OfflineIdentityExpiredError(pending));
            return;
          }
          if (sessionUser && cachedProfile?.organization_id && mounted && !accessEnded) {
            setUser(sessionUser);
            setProfile(cachedProfile);
            setOrganizations((identity!.data.organizations ?? []) as OrganizationOption[]);
            setHiddenSections(identity!.data.hiddenSections ?? []);
            const stored = readStoredRole();
            setActiveRoleState(stored && getAllowedRoles(cachedProfile).includes(stored) ? stored : cachedProfile.role);
            setOfflineScope({ userId: sessionUser.id, orgId: cachedProfile.organization_id });
            reportOffline(true, identity!.syncedAt);
            // Still open when the 12 hours pass: lock then, not only at the next load.
            confirmedAt = identity!.syncedAt ?? null;
            armExpiry({ userId: sessionUser.id, orgId: cachedProfile.organization_id });
            // Opened offline: the same rechecks as online, so access ends at the first answer from the server once the
            // connection is back, even if the browser never says "online".
            installRecheck(sessionUser, cachedProfile, identity!.data.organizations ?? []);
            return;
          }
        }
        if (mounted) {
          setUser(null);
          setProfile(null);
          setError(caught instanceof Error ? caught : new Error("Unable to load authenticated user."));
        }
      } finally {
        loadingNow = false;
        if (mounted) setLoading(false);
      }
    }

    const onAccessEnded = (event: Event) => {
      if ((event as CustomEvent<string>).detail === currentUserId && !accessEnded) void endAccess("removed");
    };
    window.addEventListener(OFFLINE_ACCESS_EVENT, onAccessEnded);
    const stopTabSignals = listenForTabSignals(window, {
      userId: () => currentUserId,
      skip: () => accessEnded || leaving || followed,
      onSignal: (signal) => {
        if (signal === "end") void endAccess("removed");
        else if (signal === "recheck") void recheck?.();
        // Company settings changed in another tab: read them again (a failed read keeps what is shown).
        else void loadCompanyProfile(true);
      },
    });
    const onOnline = () => {
      if (accessEnded) return;
      if (recheck && !expiredLock) void recheck();
      else if (!loadingNow) void loadUser(); // locked or never loaded: load for real now the server is reachable
    };
    const onFocus = () => void recheck?.();
    const onVisible = () => { if (document.visibilityState === "visible") void recheck?.(); };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const stopSyncListener = onSyncComplete((event) => {
      if (syncPassNeedsRecheck(event, fullyConfirmedAt)) void recheck?.();
    });
    void loadUser();
    return () => {
      mounted = false;
      window.removeEventListener(OFFLINE_ACCESS_EVENT, onAccessEnded);
      stopTabSignals();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      stopSyncListener();
      recheckRunner?.stop();
      if (recheckTimer) clearInterval(recheckTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
    };
  }, []);

  const setActiveRole = useCallback((role: UserRole) => {
    if (!profile || !getAllowedRoles(profile).includes(role)) return;
    writeStoredRole(role);
    setActiveRoleState(role);
  }, [profile]);

  const updateDisplayName = useCallback(async (name: string) => {
    const problem = displayNameProblem(name);
    if (problem) throw new Error(problem);
    if (!supabase || !user) throw new Error("Sign in again to change your name.");
    const fullName = normaliseDisplayName(name);
    // Their own row only: the policy "Users update own profile" allows it and the profile guard leaves full_name free.
    const { data, error: updateError } = await supabase.from("user_profiles").update({ full_name: fullName }).eq("id", user.id).select("full_name");
    if (updateError) throw updateError;
    if (!data?.length) throw new Error("Your name wasn't saved. Reload the page and try again.");
    setProfile((current) => (current ? { ...current, full_name: fullName } : current));
  }, [user]);

  const hasRole = useCallback((role: UserRole) => activeRole === role, [activeRole]);
  const hasAnyRole = useCallback((roles: UserRole[]) => roles.includes(activeRole), [activeRole]);

  const value = useMemo<UserContextValue>(() => ({
    user, profile, organizations, switchOrganization, loading, error, activeRole, setActiveRole, signOut, hasRole, hasAnyRole, hiddenSections, session, updateDisplayName,
  }), [activeRole, error, hasAnyRole, hasRole, hiddenSections, loading, organizations, profile, session, setActiveRole, signOut, switchOrganization, updateDisplayName, user]);

  return createElement(UserContext.Provider, { value }, children);
}

/** The user context, or null outside <UserProvider> (shared components that also render elsewhere). */
export function useMaybeUser(): UserContextValue | null {
  return useContext(UserContext);
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used inside <UserProvider>.");
  return ctx;
}

