"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PASSWORD_RULES, passwordProblem } from "@/lib/password";
import { type LinkDecision, type SetPasswordLink, confirmQuestion, linkDecision, needsSecondStep, readSetPasswordLink, setPasswordView } from "@/lib/set-password-link";
import { supabase } from "@/lib/supabase";
import { PRODUCT } from "@/lib/product";

// Landing page for invite and password-reset emails (both redirect here, see lib/auth-links.ts).
// The link can arrive in three shapes, depending on how the email was sent:
//   ?code=...                        reset requested from this browser (PKCE); supabase-js exchanges it on load
//   ?token_hash=...&type=...         custom email template ({{ .TokenHash }}), works from any device
//   #access_token=...&type=invite    invite sent by an admin from the server (implicit tokens in the fragment)
// Once a session exists the user chooses a password, and is then sent into the app.
// ?required=1: no link at all. The person signed in with a password an admin set, and must choose their own first
// (the middleware sends every page here until they do).
// Only invite and reset links are used, and a link never silently replaces another account signed in here (lib/set-password-link.ts).
// Someone simply signed in (no link, no temporary password) is pointed to Change password in Account Settings instead: the
// server needs their current password, which this page doesn't ask for.

type Stage = "checking" | "confirm" | "ready" | "invalid" | "saving" | "signed-in";

type Checked = { error: string } | { link: SetPasswordLink | null; decision: LinkDecision | null };

/** Reads and judges the link before anything is verified: its own error, a refused type, or who is signed in here already. */
async function checkLink(): Promise<Checked> {
  if (!supabase) return { error: "Supabase is not configured." };
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);

  const linkError = hash.get("error_description") || query.get("error_description");
  if (linkError) return { error: linkError.replace(/\+/g, " ") };

  const link = readSetPasswordLink(window.location.search, window.location.hash);
  if (link === "refused") return { error: "This link can't be used to choose a password. Use the newest invite or password reset email." };
  if (!link) return { link: null, decision: null };
  // Never leave tokens in the address bar or browser history: from here the link is kept in memory only.
  window.history.replaceState(null, "", window.location.pathname);
  const { data } = await supabase.auth.getUser();
  return { link, decision: linkDecision(link, data.user ? { id: data.user.id, email: data.user.email ?? null } : null) };
}

/** Uses the link (replacing this browser's session), then checks that a session exists. */
async function applyLink(link: SetPasswordLink | null): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  if (link?.kind === "otp") {
    const { error } = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type });
    if (error) return error.message;
  } else if (link?.kind === "tokens") {
    const { error } = await supabase.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
    if (error) return error.message;
  }

  // getSession() waits for supabase-js to finish reading the URL (it exchanges ?code= itself).
  const { data } = await supabase.auth.getSession();
  if (!data.session) return "This link is invalid or has expired.";
  // Never leave tokens in the address bar or browser history.
  window.history.replaceState(null, "", window.location.pathname);
  return null;
}

export default function SetPasswordPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("checking");
  const [message, setMessage] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [required, setRequired] = useState(false);
  const [partial, setPartial] = useState(false);
  // Another account is signed in here: the link waits (in memory) until the person chooses.
  const [pending, setPending] = useState<{ link: SetPasswordLink; decision: Extract<LinkDecision, { action: "confirm" }> } | null>(null);
  // An admin's session must pass the second step before the server takes the password (REQUIRE_ADMIN_MFA on).
  const [secondStep, setSecondStep] = useState(false);

  /** Uses the link and shows the form (or, for someone simply signed in, where to change it), or says why it can't. */
  async function establish(link: SetPasswordLink | null, isRequired: boolean, cancelled: () => boolean = () => false) {
    const error = await applyLink(link);
    if (cancelled()) return;
    if (error) {
      setMessage(error);
      setStage("invalid");
      return;
    }
    const { data } = await supabase!.auth.getUser();
    const { data: assurance } = await supabase!.auth.mfa.getAuthenticatorAssuranceLevel();
    // The temporary-password requirement itself, not only ?required=1 (gone from the address after a reload).
    const { data: own } = data.user
      ? await supabase!.from("user_profiles").select("must_change_password").eq("id", data.user.id).maybeSingle<{ must_change_password: boolean | null }>()
      : { data: null };
    if (cancelled()) return;
    setEmail(data.user?.email ?? "");
    const mustChange = isRequired || own?.must_change_password === true;
    if (mustChange) setRequired(true);
    setStage(setPasswordView({ linkUsed: link !== null, required: mustChange, methods: assurance?.currentAuthenticationMethods }) === "form" ? "ready" : "signed-in");
  }

  useEffect(() => {
    let cancelled = false;
    const isRequired = new URLSearchParams(window.location.search).get("required") === "1";
    setRequired(isRequired);
    void checkLink().then(async (checked) => {
      if (cancelled) return;
      if ("error" in checked) {
        setMessage(checked.error);
        setStage("invalid");
        return;
      }
      if (checked.link && checked.decision?.action === "confirm") {
        setPending({ link: checked.link, decision: checked.decision });
        setStage("confirm");
        return;
      }
      await establish(checked.link, isRequired, () => cancelled);
    });
    return () => { cancelled = true; };
  }, []);

  /** "Sign out and continue": this browser's session ends first, then the link is used. */
  async function continueWithLink() {
    if (!pending) return;
    setStage("checking");
    await supabase?.auth.signOut({ scope: "local" });
    await establish(pending.link, required);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const confirm = String(form.get("confirmPassword") || "");
    const problem = passwordProblem(password);
    if (problem) { setMessage(problem); return; }
    if (password !== confirm) { setMessage("Passwords do not match."); return; }
    // Through the server, which also clears "must change password" once the new password is saved.
    await submit({ password });
  }

  /** Posts to the server; success only once set-up is really complete. `partial`: password saved, finish later. */
  async function submit(body: { password: string } | { finish: true }) {
    setStage("saving");
    setMessage(null);
    const response = await fetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const result = (await response?.json().catch(() => ({}))) as { ok?: boolean; error?: string; partial?: boolean; code?: string } | undefined;
    if (!response?.ok || !result?.ok) {
      setMessage(result?.error || "Couldn't save your password. Try again.");
      setPartial(Boolean(result?.partial));
      setSecondStep(needsSecondStep(response?.status, result));
      setStage("ready");
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 py-10">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-3xl font-black tracking-tight text-brand">{PRODUCT.name}</p>
        <h1 className="text-center text-2xl font-bold text-slate-950">Choose your password</h1>
        {required && stage !== "invalid" ? <p className="mt-2 text-center text-sm text-slate-600">Your administrator set a temporary password for you. Choose your own to continue.</p> : null}
        {stage === "checking" ? <p className="mt-6 text-center text-slate-500">Checking your link…</p> : null}
        {stage === "confirm" && pending ? (
          <div className="mt-6 space-y-4 text-center">
            <div data-testid="link-other-account" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{confirmQuestion(pending.decision)}</div>
            <Button className="h-12 w-full bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => void continueWithLink()}>Sign out and continue</Button>
            <Button variant="outline" className="h-12 w-full" onClick={() => router.replace("/dashboard")}>Stay signed in as {pending.decision.signedInAs}</Button>
          </div>
        ) : null}
        {stage === "signed-in" ? (
          <div className="mt-6 space-y-4 text-center">
            <p data-testid="use-account-settings" className="text-sm text-slate-600">You&apos;re already signed in{email ? ` as ${email}` : ""}. To change your password, open Account Settings (the settings button next to your name in the menu) and use Change password.</p>
            <Button className="bg-brand text-brand-ink" onClick={() => router.replace("/dashboard")}>Go to the dashboard</Button>
          </div>
        ) : null}
        {stage === "invalid" ? (
          <div className="mt-6 space-y-4 text-center">
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div>
            <p className="text-sm text-slate-600">Links work once and expire after a while. Ask your administrator for a new invite, or use &quot;Reset password&quot; on the sign-in page. Open the newest email&apos;s link in the same browser.</p>
            <Button className="bg-brand text-brand-ink" onClick={() => router.replace("/login")}>Go to sign in</Button>
          </div>
        ) : null}
        {stage === "ready" || stage === "saving" ? (
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {email ? <p className="text-center text-sm text-slate-600">For {email}</p> : null}
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              New password
              <Input name="password" type="password" required minLength={12} autoComplete="new-password" className="h-12" />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              Confirm password
              <Input name="confirmPassword" type="password" required minLength={12} autoComplete="new-password" className="h-12" />
            </label>
            <p className="text-xs text-slate-500">{PASSWORD_RULES}</p>
            {message ? <div aria-live="polite" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div> : null}
            {/* /mfa always continues to the dashboard, so it opens in a new tab and this page (and its session) stays here. */}
            {secondStep ? (
              <p data-testid="set-password-mfa" className="text-center text-sm text-slate-600">
                <a href="/mfa" target="_blank" rel="noopener" className="font-medium text-brand underline">Enter your authenticator code</a> (opens in a new tab), then come back here and save again.
              </p>
            ) : null}
            {partial ? (
              <Button type="button" disabled={stage === "saving"} onClick={() => void submit({ finish: true })} className="h-12 w-full bg-brand text-brand-ink hover:bg-brand-hover">
                {stage === "saving" ? "Finishing..." : "Finish set-up"}
              </Button>
            ) : (
              <Button type="submit" disabled={stage === "saving"} className="h-12 w-full bg-brand text-brand-ink hover:bg-brand-hover">
                {stage === "saving" ? "Saving..." : "Save password and continue"}
              </Button>
            )}
            {required ? (
              <button type="button" className="w-full py-2 text-center text-sm text-slate-500 hover:underline" onClick={async () => { await supabase?.auth.signOut(); window.location.assign("/login"); }}>
                Sign out
              </button>
            ) : null}
          </form>
        ) : null}
      </div>
    </main>
  );
}
