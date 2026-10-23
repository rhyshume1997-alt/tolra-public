"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmLocalSignOut } from "@/lib/auth-errors";
import { ADMIN_MFA_ONBOARDING_SELF, MFA_ENROL_PARAM } from "@/lib/mfa-policy";
import { PRODUCT } from "@/lib/product";
import { supabase } from "@/lib/supabase";

// Second step of sign-in for admins (authenticator app, TOTP). Two screens:
//   set up   the first time: scan the QR code (or type the key) into an authenticator app, then enter the 6-digit code;
//   confirm  every later sign-in: enter the 6-digit code.
// The middleware sends an admin here until the session is at assurance level aal2 (lib/mfa-policy.ts). Lost your phone: another
// admin resets it from Admin > Users, or see docs/MFA.md. Someone another admin has just made an admin is sent here with ?enrol=1
// (migration 065) until they have set one up, even while REQUIRE_ADMIN_MFA is off; the screen says why.

type Stage = "checking" | "setup" | "confirm" | "saving" | "error";
const SIGN_OUT_FAILED = "Sign-out failed — try again.";
const SETUP_FAILED = "Couldn't start the set-up. Try again, or ask another admin.";
type Enrolment = { factorId: string; qr: string; secret: string };

export default function MfaPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("checking");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [newAdmin, setNewAdmin] = useState(false);

  useEffect(() => {
    setNewAdmin(new URLSearchParams(window.location.search).get(MFA_ENROL_PARAM) === "1");
  }, []);

  const done = useCallback(() => {
    router.replace("/dashboard");
    router.refresh();
  }, [router]);

  /** Leaves "One moment…": shows why and offers Retry (Sign out is always on screen). */
  const fail = useCallback((text: string) => {
    setMessage(text);
    setStage("error");
  }, []);

  const startEnrolment = useCallback(async () => {
    if (!supabase) return;
    setMessage(null);
    // A set-up that was abandoned halfway leaves an unverified factor behind: remove it, or the new one is refused.
    const { data: existing, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) return fail(SETUP_FAILED);
    for (const factor of existing?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `${PRODUCT.name} ${new Date().toISOString().slice(0, 10)}` });
    if (error || !data) return fail(SETUP_FAILED);
    setEnrolment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setStage("setup");
  }, [fail]);

  const load = useCallback(async (isLive: () => boolean) => {
    if (!supabase) return fail("Sign-in isn't available right now. Please contact support.");
    try {
      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!isLive()) return;
      if (assuranceError) return fail(SETUP_FAILED);
      if (assurance?.currentLevel === "aal2") return done();
      const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (!isLive()) return;
      // Not "no factor yet": enrolling on a failed lookup could start a second set-up for someone who already has one.
      if (factorsError) return fail(SETUP_FAILED);
      const verified = factors?.totp?.[0];
      if (verified) {
        setFactorId(verified.id);
        setStage("confirm");
      } else {
        await startEnrolment();
      }
    } catch (err) {
      console.error(err);
      if (isLive()) fail(SETUP_FAILED);
    }
  }, [done, fail, startEnrolment]);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

  function retry() {
    setMessage(null);
    setEnrolment(null);
    setStage("checking");
    void load(() => true);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const code = String(new FormData(event.currentTarget).get("code") || "").replace(/\s/g, "");
    const id = stage === "setup" ? enrolment?.factorId : factorId;
    if (!id || !/^\d{6}$/.test(code)) {
      setMessage("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setStage("saving");
    setMessage(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: id, code });
    if (error) {
      setMessage("That code didn't work. Check the code in your app (it changes every 30 seconds) and try again.");
      setStage(enrolment ? "setup" : "confirm");
      return;
    }
    done();
  }

  async function signOut() {
    setSignOutError(null);
    setSigningOut(true);
    const gone = !supabase || (await confirmLocalSignOut(supabase.auth));
    setSigningOut(false);
    // Only leave once the local session is confirmed removed; otherwise a live session would stay on a shared device.
    if (gone) window.location.assign("/login");
    else setSignOutError(SIGN_OUT_FAILED);
  }

  const busy = stage === "saving" || stage === "checking";

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 py-10">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-3xl font-black tracking-tight text-brand">{PRODUCT.name}</p>
        <h1 className="text-center text-2xl font-bold text-slate-950">{stage === "setup" ? "Set up two-step sign-in" : "Enter your code"}</h1>
        {newAdmin && stage !== "confirm" ? <p role="status" data-testid="mfa-new-admin" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{ADMIN_MFA_ONBOARDING_SELF}</p> : null}
        {stage === "checking" ? <p className="mt-6 text-center text-slate-500">One moment…</p> : null}
        {(stage === "setup" || (stage === "saving" && enrolment)) && enrolment ? (
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <p>Administrators sign in with a second step. In an authenticator app on your phone (Microsoft Authenticator, Google Authenticator or similar), add an account by scanning this code:</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrolment.qr} alt="QR code for your authenticator app" className="mx-auto h-48 w-48" />
            <p className="text-xs text-slate-500">Can&apos;t scan it? Enter this key in the app instead: <code data-testid="mfa-secret" className="break-all font-mono text-slate-800">{enrolment.secret}</code></p>
            <p>Then type the 6-digit code the app shows.</p>
          </div>
        ) : null}
        {stage === "confirm" || (stage === "saving" && !enrolment) ? <p className="mt-2 text-center text-sm text-slate-600">Open your authenticator app and enter the 6-digit code for {PRODUCT.name}.</p> : null}
        {stage === "error" ? (
          <div className="mt-4 space-y-4">
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div>
            <Button type="button" onClick={retry} className="h-12 w-full bg-brand text-brand-ink hover:bg-brand-hover">Retry</Button>
          </div>
        ) : null}
        {stage !== "checking" && stage !== "error" ? (
          <form onSubmit={submit} className="mt-4 space-y-4">
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              6-digit code
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required className="h-12 text-center font-mono text-lg tracking-widest" />
            </label>
            {message ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div> : null}
            <Button type="submit" disabled={busy} className="h-12 w-full bg-brand text-brand-ink hover:bg-brand-hover">{stage === "saving" ? "Checking…" : stage === "setup" ? "Turn on and continue" : "Continue"}</Button>
            <p className="text-center text-xs text-slate-500">Lost your phone? Ask another administrator to reset your two-step sign-in (Admin &gt; Users).</p>
          </form>
        ) : null}
        {signOutError ? <div role="alert" data-testid="mfa-signout-error" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{signOutError}</div> : null}
        {/* Always reachable, whichever stage the page is stuck in. */}
        <button type="button" className="mt-2 w-full py-2 text-center text-sm text-slate-500 hover:underline" disabled={signingOut} onClick={() => void signOut()}>Sign out</button>
      </div>
    </main>
  );
}
