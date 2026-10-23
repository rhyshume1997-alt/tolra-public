"use client";

import "@fontsource/anton/400.css";

import Image from "next/image";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useRef, useState } from "react";

import { type LoginBranding } from "@/lib/branding";
import { withProductCredit } from "@/lib/product";

type Props = {
  branding: LoginBranding;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onResetPassword: (email: string) => Promise<void>;
  error?: string | null;
  /** Show a Retry button with the error (the sign-in could not reach the server): it re-submits the form as typed. */
  canRetry?: boolean;
  messageType?: "error" | "success";
  loading?: boolean;
  resetLoading?: boolean;
};

/** "Made to your drawing. Checked before it ships." -> one line per sentence, each keeping its full stop. */
function statementLines(text: string) {
  const parts = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

/**
 * Website-style sign-in (Settings > Sign-in style: Dark): the company's brand colour as the page, its tagline as a
 * large uppercase statement, mono labels, pill button with an icon chip. Display font: Anton (free; stands in for a
 * company's own display face).
 */
export function DarkSignIn({ branding, onSubmit, onResetPassword, error, canRetry, messageType = "error", loading, resetLoading }: Props) {
  const [identifier, setIdentifier] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const { name, primary, accent, logo } = branding;
  const statement = statementLines(branding.tagline || `${name}.`);
  const theme = {
    "--page": primary,
    "--raised": `color-mix(in srgb, ${primary} 92%, white)`,
    "--accent": accent,
    "--accent-light": `color-mix(in srgb, ${accent} 50%, white)`,
    "--text-2": "rgba(235, 240, 248, 0.62)",
    "--text-3": "rgba(235, 240, 248, 0.38)",
    "--hair": "rgba(255, 255, 255, 0.1)",
  } as React.CSSProperties;
  const label = "font-mono text-[0.7rem] font-medium uppercase tracking-[0.16em] text-[var(--text-2)]";
  const field = "h-12 w-full rounded-xl border border-[var(--hair)] bg-white/[0.04] px-4 text-[0.95rem] text-white outline-none transition placeholder:text-[var(--text-3)] focus:border-[var(--accent-light)] focus:bg-white/[0.06]";

  return (
    <div style={theme} className="relative min-h-screen overflow-hidden bg-[var(--page)] font-sans text-white">
      {/* Fine engineering grid, fading out: texture, not decoration. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)", backgroundSize: "72px 72px", maskImage: "radial-gradient(ellipse at 20% 30%, black 20%, transparent 70%)" }} />

      <div className="relative mx-auto flex min-h-screen max-w-[1320px] flex-col px-6 py-6 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {logo ? (
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white p-1.5">
                <Image src={logo} alt={`${name} logo`} width={44} height={44} unoptimized className="max-h-full w-auto object-contain" />
              </div>
            ) : null}
            <span className="truncate text-[0.95rem] font-semibold tracking-tight">{name}</span>
          </div>
          <span className={`${label} hidden sm:block`}>Staff sign-in</span>
        </header>

        <main className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[1.25fr_minmax(360px,440px)] lg:gap-20">
          <section aria-label={`${name}`}>
            {branding.eyebrow ? <p className="font-mono text-[0.72rem] font-medium uppercase tracking-[0.2em] text-[var(--accent-light)]">{branding.eyebrow}</p> : null}
            <h2 className="mt-6 font-[family-name:var(--font-display)] text-[clamp(2.75rem,7.2vw,6.75rem)] uppercase leading-[0.94] tracking-[0.005em]">
              {statement.map((line, index) => <span key={index} className="block">{line}</span>)}
            </h2>
            <p className="mt-8 max-w-md text-[1.0625rem] font-light leading-relaxed text-[var(--text-2)]">
              Quotes, jobs, worksheets and delivery for the {name} team.
            </p>
          </section>

          <section className="rounded-2xl border border-[var(--hair)] bg-[var(--raised)] p-7 sm:p-9" aria-labelledby="dark-signin-title">
            <h1 id="dark-signin-title" className="text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="mt-2 text-sm text-[var(--text-2)]">Use the username or email your administrator gave you.</p>

            <form ref={formRef} onSubmit={onSubmit} className="mt-8 space-y-5">
              <label className="grid gap-2">
                <span className={label}>Username or email</span>
                <input name="identifier" type="text" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} className={field} />
              </label>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="dark-password" className={label}>Password</label>
                  <button type="button" disabled={resetLoading} onClick={() => onResetPassword(identifier)}
                    className="-my-3 py-3 text-sm text-[var(--accent-light)] hover:underline disabled:opacity-60">
                    {resetLoading ? "Sending..." : "Forgot password?"}
                  </button>
                </div>
                <div className="relative">
                  <input id="dark-password" name="password" type={showPassword ? "text" : "password"} required autoComplete="current-password" className={`${field} pr-12`} />
                  <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2.5 text-[var(--text-3)] hover:text-white">
                    {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                  </button>
                </div>
              </div>
              <label className="flex items-center gap-2.5 text-sm text-[var(--text-2)]">
                <input type="checkbox" name="remember" className="size-4 accent-[var(--accent)]" />Keep me signed in
              </label>
              {error ? (
                <div aria-live="polite" className={messageType === "success"
                  ? "rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100"
                  : "rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100"}>
                  {error}
                  {canRetry && messageType === "error" ? <button type="button" disabled={loading} onClick={() => formRef.current?.requestSubmit()} className="mt-2 block font-semibold underline disabled:opacity-60">Retry</button> : null}
                </div>
              ) : null}
              <button type="submit" disabled={loading}
                className="group flex h-14 w-full items-center justify-between rounded-full border border-white/25 py-[7px] pl-[30px] pr-[7px] font-mono text-[0.78rem] font-medium uppercase tracking-[0.16em] text-white transition hover:border-white/45 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)]/40 disabled:opacity-60">
                {loading ? "Signing in..." : "Sign in"}
                <span className="flex size-10 items-center justify-center rounded-full bg-[var(--accent)] transition group-hover:translate-x-0.5">
                  <ArrowRight className="size-4" aria-hidden />
                </span>
              </button>
            </form>
          </section>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hair)] pt-5 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-[var(--text-3)]">
          <span>{withProductCredit(name)}</span>
          <span>Authorised staff only</span>
        </footer>
      </div>
    </div>
  );
}
