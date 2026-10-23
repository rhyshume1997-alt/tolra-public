"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PASSWORD_RULES, passwordProblem } from "@/lib/password";
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

type Stage = "checking" | "ready" | "invalid" | "saving";

const OTP_TYPES: EmailOtpType[] = ["invite", "recovery", "signup", "magiclink", "email"];

async function establishSession(): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);

  const linkError = hash.get("error_description") || query.get("error_description");
  if (linkError) return linkError.replace(/\+/g, " ");

  const tokenHash = query.get("token_hash");
  const type = query.get("type") as EmailOtpType | null;
  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return error.message;
  }

  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
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

  useEffect(() => {
    let cancelled = false;
    setRequired(new URLSearchParams(window.location.search).get("required") === "1");
    void establishSession().then(async (error) => {
      if (cancelled) return;
      if (error) {
        setMessage(error);
        setStage("invalid");
        return;
      }
      const { data } = await supabase!.auth.getUser();
      if (cancelled) return;
      setEmail(data.user?.email ?? "");
      setStage("ready");
    });
    return () => { cancelled = true; };
  }, []);

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
    const result = (await response?.json().catch(() => ({}))) as { ok?: boolean; error?: string; partial?: boolean } | undefined;
    if (!response?.ok || !result?.ok) {
      setMessage(result?.error || "Couldn't save your password. Try again.");
      setPartial(Boolean(result?.partial));
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
