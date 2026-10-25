"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { DisplayNamePrompt } from "@/components/display-name";
import { OfflineBanner } from "@/components/offline-banner";
import { Sidebar } from "@/components/sidebar";
import { SupportBanner } from "@/components/support-banner";
import { ThemeColour } from "@/components/theme-colour";
import { Topbar } from "@/components/topbar";
import { Skeleton } from "@/components/ui/skeleton";
import { type ShellBrand, shellColours } from "@/lib/brand-pending";
import { LAST_ORG_KEY } from "@/lib/branding";
import { primeShellBrand } from "@/lib/company";
import { OFFLINE_IDENTITY_MAX_AGE_HOURS, OfflineIdentityExpiredError } from "@/lib/offline/identity-age";
import { useIdleSignOut } from "@/lib/use-idle-sign-out";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/friendly-error";
import { UserProvider, useUser } from "@/lib/use-user";

const REMEMBERED_KEY = "qf.brand.remembered";

/**
 * After sign-in and after a company switch (both load the app afresh), asks the server to remember this session's company for the
 * next sign-in page (app/api/branding/remember: the server decides, from the session, and only for a company with branded sign-in
 * on). Once per company per tab. The browser-only record from before the cookie is then no longer needed.
 */
function useRememberBrand(organizationId: string | null | undefined) {
  useEffect(() => {
    if (!organizationId || !supabase) return;
    try { if (window.sessionStorage.getItem(REMEMBERED_KEY) === organizationId) return; } catch { /* storage blocked: ask again */ }
    void fetch("/api/branding/remember", { method: "POST" }).then((response) => {
      if (!response.ok) return;
      try {
        window.sessionStorage.setItem(REMEMBERED_KEY, organizationId);
        window.localStorage.removeItem(LAST_ORG_KEY);
      } catch { /* storage blocked */ }
    }).catch(() => undefined);
  }, [organizationId]);
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, profile, loading, error, activeRole } = useUser();
  // Signs this device out after the idle limit for the role being worked as (lib/session-policy.ts).
  useIdleSignOut(activeRole, Boolean(user && profile));
  useRememberBrand(user && profile ? profile.organization_id : null);

  // The middleware sends people here when an admin has hidden the page they asked for.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("blocked") !== "1") return;
    // Next tick: this effect runs before the root layout's <Toaster> has subscribed.
    setTimeout(() => toast.info("You don't have access to that page. Ask your administrator if you need it."), 0);
    url.searchParams.delete("blocked");
    window.history.replaceState(null, "", url.pathname + url.search);
  }, []);

  useEffect(() => {
    if (!loading && !isSupabaseConfigured) {
      router.replace("/configuration-error");
      return;
    }

    if (!loading && supabase && !error && (!user || !profile)) {
      router.replace("/login");
    }
  }, [error, loading, profile, router, user]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="mt-6 h-96 w-full" />
      </div>
    );
  }

  if (!isSupabaseConfigured) return null;
  if (error instanceof OfflineIdentityExpiredError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div role="alert" className="max-w-md rounded-lg border border-amber-300 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-950">Connect to sign in again</h1>
          <p className="mt-2 text-sm text-slate-600">
            This device has been offline for more than {OFFLINE_IDENTITY_MAX_AGE_HOURS} hours, so it can&apos;t be used offline any longer. Get back online and try again.
          </p>
          <p className="mt-2 text-sm font-medium text-slate-800" data-testid="offline-kept">
            {error.pending
              ? `${error.pending} change${error.pending === 1 ? "" : "s"} you made offline ${error.pending === 1 ? "is" : "are"} still saved on this device and will be sent once you are back online.`
              : "Nothing you entered offline is waiting on this device."}
          </p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Try again</button>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div role="alert" className="max-w-md rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-950">Can&apos;t load your account</h1>
          <p className="mt-2 text-sm text-slate-600">{friendlyError(error, "Can't reach the server. Check your connection and try again.")}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Retry</button>
        </div>
      </div>
    );
  }
  if (supabase && (!user || !profile)) return null;

  return (
    // Printing shows the page content only: no navigation, no shell spacing (print routes and any page).
    <div className="min-h-screen bg-canvas print:min-h-0 print:bg-white">
      <div className="print:hidden"><Sidebar /></div>
      <ThemeColour />
      <SupportBanner />
      <div className="min-h-screen desk:pl-[248px] print:min-h-0 print:pl-0">
        <Topbar />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-6 md:py-8 desk:px-10 desk:py-10 print:max-w-none print:p-0"><DisplayNamePrompt /><OfflineBanner />{children}</main>
      </div>
    </div>
  );
}

/**
 * `company` is the brand (name, colours, logo URL) the server read for this session (app/(dashboard)/layout.tsx), or undefined: the
 * browser reads the company as before. It is held until the full profile loads (lib/company.ts primeShellBrand), and its colours
 * go into the server HTML, so the first paint already wears the company's brand (no neutral placeholder, no product navy).
 */
export function DashboardShell({ children, company }: { children: React.ReactNode; company?: ShellBrand }) {
  // Held once per page load (browser only) before the children render. The server HTML has no company content: the shell renders its loading state there.
  useState(() => { if (company) primeShellBrand(company); return null; });
  const colours = company ? shellColours(company, false) : null;
  return (
    <UserProvider>
      {/* Hex colours only (shellColours validates them), so nothing else can reach CSS. */}
      {colours ? <style>{`:root{--brand:${colours.primary};--brand-accent:${colours.accent};--brand-ink:${colours.ink}}`}</style> : null}
      <ShellInner>{children}</ShellInner>
    </UserProvider>
  );
}
