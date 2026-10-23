"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { SignIn } from "@/components/ui/sign-in";
import { discardedMessage, takeDiscardedNotice } from "@/lib/offline/store";
import { EXPIRED_NOTICE_COOKIE, LOCK_NOTICE_KEY, forgetLastActive, idleMessage } from "@/lib/session-policy";
import { adoptServerAccessEnded } from "@/lib/offline/access";
import { INVALID_CREDENTIALS_MESSAGE, UNREACHABLE_MESSAGE, classifySignInResponse, isUnreachableError } from "@/lib/auth-errors";
import { supabase } from "@/lib/supabase";
import { isOrgSlug, type LoginBranding } from "@/lib/branding";

const LAST_ORG_KEY = "qf.login.org";

/** Branding for /login?org=<slug>, the company subdomain, or (on this device) the last branded link used. */
function useLoginBranding(orgParam: string | null) {
  const [branding, setBranding] = useState<LoginBranding | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fromParam = isOrgSlug(orgParam?.toLowerCase()) ? orgParam!.toLowerCase() : null;
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(LAST_ORG_KEY); } catch { /* storage blocked */ }
    const slug = fromParam ?? (isOrgSlug(stored) ? stored : null);
    // No slug: the API still checks the host (jnr-engineering.<TENANT_ROOT_DOMAIN>).
    fetch(slug ? `/api/branding?org=${encodeURIComponent(slug)}` : "/api/branding")
      .then(async (response) => (response.ok ? ((await response.json()) as LoginBranding | null) : null))
      .catch(() => null)
      .then((result) => {
        if (cancelled) return;
        setBranding(result);
        try {
          if (result) window.localStorage.setItem(LAST_ORG_KEY, result.slug);
          else if (slug && !fromParam) window.localStorage.removeItem(LAST_ORG_KEY);
        } catch { /* storage blocked */ }
      });
    return () => { cancelled = true; };
  }, [orgParam]);
  return branding;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const disabled = searchParams.get("disabled") === "1";
  const branding = useLoginBranding(searchParams.get("org"));
  const [error, setError] = useState<string | null>(disabled ? "Your account has been disabled" : null);
  const [messageType, setMessageType] = useState<"error" | "success">("error");
  const [canRetry, setCanRetry] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  // A new sign-in starts its own idle clock; the previous one's last-use time must not lock it at once.
  useEffect(() => { forgetLastActive(); }, []);

  // The middleware may have refused a disabled account and marked access ended on this device (lib/offline/access.ts), possibly
  // on a request this page never saw: every other open tab is told through the storage mark and locks now, keeping its queued
  // work. This only ever suspends; a fresh server confirmation is the only thing that clears the mark.
  useEffect(() => { adoptServerAccessEnded(); }, []);

  // This device locked or expired the sign-in after the idle limit (lib/session-policy.ts): say why, and that offline changes were kept.
  const idleParam = searchParams.get("locked") === "1" ? "locked" : searchParams.get("expired") === "1" ? "expired" : searchParams.get("ended") === "1" ? "ended" : null;
  useEffect(() => {
    if (!idleParam) return;
    let pending = 0;
    try {
      const notice = JSON.parse(window.localStorage.getItem(LOCK_NOTICE_KEY) || "null") as { pending?: number } | null;
      pending = Number(notice?.pending) || 0;
      window.localStorage.removeItem(LOCK_NOTICE_KEY);
    } catch { /* storage blocked: the plain message */ }
    setMessageType("success");
    setError(idleMessage(idleParam, pending));
    // The message is on screen: the middleware's "expired" notice has done its job.
    document.cookie = `${EXPIRED_NOTICE_COOKIE}=; Max-Age=0; path=/`;
  }, [idleParam]);

  // Unsynced offline changes a sign-out or ended session removed from this device: said once, never silent.
  useEffect(() => {
    const discarded = takeDiscardedNotice();
    if (discarded) setError((current) => `${current ? `${current}. ` : ""}${discardedMessage(discarded, "")}`);
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCanRetry(false);
    setMessageType("error");
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const identifier = String(form.get("identifier") || "").trim();
    const password = String(form.get("password") || "");

    try {
      if (!supabase) throw new Error("Sign-in isn't available right now. Please contact support.");
      // The server resolves a username to its e-mail and signs in there (sets the session cookies); the browser
      // never sees whether a username or e-mail exists.
      let response: Response;
      try {
        response = await fetch("/api/auth/signin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier, password }) });
      } catch {
        throw new Error("unreachable");
      }
      const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        const failure = classifySignInResponse(response.status, result.error);
        throw new Error(failure.kind === "too_many" ? failure.message : failure.kind === "unreachable" ? "unreachable" : "invalid");
      }
      const { data, error: userError } = await supabase.auth.getUser();
      // The server said the sign-in worked, so no user (or any error) here is a session/service failure, never "wrong password".
      const userId = data.user?.id;
      if (userError || !userId) {
        console.error(userError ?? "sign-in succeeded but getUser returned no user");
        throw new Error("unreachable");
      }

      const { data: profileCheck, error: profileError, status: profileStatus } = await supabase
        .from("user_profiles")
        .select("id, active")
        .eq("id", userId)
        .maybeSingle();

      if (profileError || !profileCheck) {
        console.error(profileError);
        await supabase.auth.signOut().catch(() => undefined);
        // Any failed lookup (an error object, or a 0 / 5xx HTTP status that PostgREST reports apart from the error body) is
        // retryable; only a successful lookup that returns no profile means "contact your administrator".
        if (profileError || profileStatus === 0 || profileStatus >= 500 || isUnreachableError(profileError)) throw new Error("unreachable");
        throw new Error("We couldn't load your account. Contact your administrator.");
      }

      if (profileCheck.active === false) {
        await supabase.auth.signOut();
        setError("Your account has been disabled");
        return;
      }

      const { data: profile, error: roleError } = await supabase
        .from("user_profiles")
        .select("role, secondary_role")
        .eq("id", userId)
        .maybeSingle();

      // Never route on an unknown role: a failed or empty lookup could send an admin straight to /dashboard.
      if (roleError || !profile) {
        console.error(roleError ?? "role lookup returned no profile");
        await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        throw new Error("unreachable");
      }

      const shouldChooseRole = profile?.role === "admin" || Boolean(profile?.secondary_role);
      router.replace(shouldChooseRole ? "/select-role" : "/dashboard");
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message !== "invalid" && message !== "unreachable") console.error(err);
      // A thrown fetch from anywhere above (e.g. the browser's own auth call) is also "can't reach", not "wrong password".
      if (message === "unreachable" || isUnreachableError(err)) {
        setError(UNREACHABLE_MESSAGE);
        setCanRetry(true);
      } else {
        setError(message.startsWith("We couldn't") || message.startsWith("Sign-in isn't") || message.startsWith("Too many") ? message : INVALID_CREDENTIALS_MESSAGE);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(identifier: string) {
    setError(null);
    setMessageType("error");
    const trimmed = identifier.trim();
    if (!trimmed) {
      setError("Enter your username or email address, then choose \"Forgot password?\".");
      return;
    }

    setResetLoading(true);
    try {
      const response = await fetch("/api/auth/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: trimmed }) });
      const result = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "Couldn't send the password reset email. Try again.");
      setMessageType("success");
      setError(result.message || "If that account exists, we've sent a password reset email to its address.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the password reset email. Try again.");
    } finally {
      setResetLoading(false);
    }
  }

  return <SignIn onSubmit={handleSubmit} onResetPassword={handleResetPassword} error={error} canRetry={canRetry} messageType={messageType} loading={loading} resetLoading={resetLoading} branding={branding} />;
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
