"use client";

import Image from "next/image";
import { CalendarClock, ClipboardList, Eye, EyeOff, FileText, Lock } from "lucide-react";
import { useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { DarkSignIn } from "@/components/ui/sign-in-dark";
import { type LoginBranding, PRODUCT_BRANDING, textOn } from "@/lib/branding";
import { PRODUCT, withProductCredit } from "@/lib/product";

type SignInProps = {
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onResetPassword: (email: string) => Promise<void>;
  error?: string | null;
  /** Show a Retry button with the error (the sign-in could not reach the server): it re-submits the form as typed. */
  canRetry?: boolean;
  messageType?: "error" | "success";
  loading?: boolean;
  resetLoading?: boolean;
  /** The organisation's sign-in branding (rendered by the server: app/login/page.tsx), or null for the neutral product page. */
  branding?: LoginBranding | null;
};

const FEATURES = [
  { icon: FileText, title: "Quotes, POs and invoices", detail: "Branded documents with your numbering, VAT and terms." },
  { icon: ClipboardList, title: "Job worksheets", detail: "Drawings, materials, machine times and sign-off in one place." },
  { icon: CalendarClock, title: "Machine schedule", detail: "See which machines are free and when each job will finish." },
];

function Monogram({ name, className }: { name: string; className: string }) {
  const letters = name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 3).toUpperCase() || "QF";
  return <div className={`flex items-center justify-center font-black tracking-tight ${className}`}>{letters}</div>;
}

/** The company's own sign-in style (Settings > Sign-in style), else the light layout (also the neutral product page). */
export function SignIn(props: SignInProps) {
  if (props.branding?.style === "dark") return <DarkSignIn {...props} branding={props.branding} />;
  return <LightSignIn {...props} />;
}

function LightSignIn({ onSubmit, onResetPassword, error, canRetry, messageType = "error", loading, resetLoading, branding }: SignInProps) {
  const [email, setEmail] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // A logo that fails to load falls back to the monogram (the company name stays on the page either way).
  const [logoFailed, setLogoFailed] = useState(false);
  const brand = branding ?? null;
  const logo = logoFailed ? null : brand?.logo ?? null;
  const name = brand?.name ?? PRODUCT_BRANDING.name;
  const tagline = brand?.tagline || PRODUCT_BRANDING.tagline;
  const primary = brand?.primary ?? PRODUCT_BRANDING.primary;
  const accent = brand?.accent ?? PRODUCT_BRANDING.accent;
  const onPrimary = textOn(primary);
  const theme = { "--brand": primary, "--brand-accent": accent, "--brand-text": onPrimary } as React.CSSProperties;

  const logoMark = (size: "lg" | "sm") => logo ? (
    <div className={size === "lg" ? "rounded-2xl bg-white p-4 shadow-2xl shadow-black/20 ring-1 ring-white/40" : "rounded-xl bg-white p-2 shadow-md ring-1 ring-slate-200"}>
      <Image src={logo} alt={`${name} logo`} width={size === "lg" ? 160 : 72} height={size === "lg" ? 160 : 72} unoptimized priority onError={() => setLogoFailed(true)}
        className={size === "lg" ? "h-28 w-auto object-contain" : "h-12 w-auto object-contain"} />
    </div>
  ) : brand ? (
    <Monogram name={name} className={size === "lg" ? "size-20 rounded-2xl bg-white/15 text-2xl ring-1 ring-white/30 backdrop-blur" : "size-12 rounded-xl bg-[var(--brand)] text-base text-[var(--brand-text)]"} />
  ) : null;

  return (
    <div style={theme} className="grid min-h-screen bg-slate-50 lg:grid-cols-[1.15fr_1fr]">
      <style>{`
        @keyframes qfRise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        .qf-rise { animation: qfRise .6s cubic-bezier(.2,.7,.2,1) both; }
        @media (prefers-reduced-motion: reduce) { .qf-rise { animation: none; } }
      `}</style>

      {/* Brand panel: the organisation's colours (or the product's). Nothing on it is shared between companies. */}
      <section className="relative hidden overflow-hidden lg:block" aria-label={`${name} sign-in`} style={{ color: onPrimary }}>
        <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${primary} 0%, ${primary} 45%, ${accent} 100%)` }} />
        <div className="absolute -right-32 -top-32 size-[34rem] rounded-full opacity-30 blur-3xl" style={{ background: accent }} />
        <div className="absolute -bottom-40 -left-24 size-[28rem] rounded-full opacity-25 blur-3xl" style={{ background: "#ffffff" }} />
        <div className="absolute inset-0 opacity-[0.12]" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px)", backgroundSize: "56px 56px", maskImage: "radial-gradient(ellipse at 30% 40%, black 30%, transparent 75%)" }} />

        <div className="relative flex h-full flex-col justify-between p-12 xl:p-16">
          <div className="qf-rise flex items-center gap-5">
            {logoMark("lg")}
            {!logo ? <p className="text-4xl font-black tracking-tight">{name}</p> : null}
          </div>

          <div className="qf-rise max-w-xl" style={{ animationDelay: "120ms" }}>
            {logo ? <p className="text-sm font-semibold uppercase tracking-[0.25em] opacity-70">{name}</p> : null}
            <h2 className="mt-3 text-4xl font-bold leading-tight tracking-tight xl:text-5xl">{tagline}</h2>
            <div className="mt-10 grid gap-3">
              {FEATURES.map(({ icon: Icon, title, detail }, index) => (
                <div key={title} className="qf-rise flex items-start gap-4 rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-md" style={{ animationDelay: `${220 + index * 90}ms` }}>
                  <div className="rounded-xl bg-white/15 p-2.5"><Icon className="size-5" aria-hidden /></div>
                  <div>
                    <p className="font-semibold">{title}</p>
                    <p className="mt-0.5 text-sm opacity-80">{detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs opacity-60">{brand ? `Powered by ${PRODUCT.name}` : `${PRODUCT.name} · ${PRODUCT.tagline.replace(/\.$/, "")}`}</p>
        </div>
      </section>

      {/* Form */}
      <section className="flex min-h-screen flex-col">
        <div className="h-1.5 w-full lg:hidden" style={{ background: `linear-gradient(90deg, ${primary}, ${accent})` }} />
        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="qf-rise w-full max-w-md">
            <div className="mb-8 flex flex-col items-center text-center">
              <div className="lg:hidden">{logoMark("sm")}</div>
              {!brand ? <p className="text-3xl font-black tracking-tight text-[var(--brand)]">{PRODUCT.name}</p> : null}
              <h1 className="mt-5 text-3xl font-bold tracking-tight text-slate-950">{brand ? `Sign in to ${name}` : "Welcome back"}</h1>
              <p className="mt-2 text-sm text-slate-500">{brand ? "Use the username or email your administrator gave you." : `Sign in to your workshop's ${PRODUCT.name} account.`}</p>
            </div>

            <div className="rounded-3xl border border-slate-200/80 bg-white p-7 shadow-xl shadow-slate-900/5 sm:p-8">
              <form ref={formRef} onSubmit={onSubmit} className="space-y-5">
                <label className="grid gap-2 text-sm font-medium text-slate-700">
                  Username or email
                  <Input name="identifier" type="text" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false}
                    className="h-12 rounded-xl border-slate-200 bg-slate-50/60 px-4 focus-visible:border-[var(--brand)] focus-visible:ring-[var(--brand)]/30" />
                </label>
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <label htmlFor="password" className="font-medium text-slate-700">Password</label>
                    <button type="button" disabled={resetLoading} onClick={() => onResetPassword(email)}
                      className="-my-3 py-3 font-medium text-[var(--brand-accent)] hover:underline disabled:cursor-not-allowed disabled:opacity-60">
                      {resetLoading ? "Sending..." : "Forgot password?"}
                    </button>
                  </div>
                  <div className="relative">
                    <Input id="password" name="password" type={showPassword ? "text" : "password"} required autoComplete="current-password"
                      className="h-12 rounded-xl border-slate-200 bg-slate-50/60 px-4 pr-12 focus-visible:border-[var(--brand)] focus-visible:ring-[var(--brand)]/30" />
                    <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-2.5 text-slate-400 hover:text-slate-600">
                      {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                    </button>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" name="remember" className="size-4 accent-[var(--brand)]" />Keep me signed in</label>
                {error ? (
                  <div aria-live="polite"
                    className={messageType === "success" ? "rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700" : "rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"}>
                    {error}
                    {canRetry && messageType === "error" ? <button type="button" disabled={loading} onClick={() => formRef.current?.requestSubmit()} className="mt-2 block font-semibold underline disabled:opacity-60">Retry</button> : null}
                  </div>
                ) : null}
                <button type="submit" disabled={loading}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-none font-mono text-[0.75rem] font-medium uppercase tracking-[0.12em] transition hover:brightness-90 active:translate-y-px focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--brand)]/30 disabled:opacity-70"
                  style={{ background: primary, color: onPrimary }}>
                  <Lock className="size-4" aria-hidden />{loading ? "Signing in..." : "Sign in"}
                </button>
              </form>
            </div>

            <p className="mt-8 text-center text-xs text-slate-400">{brand ? withProductCredit(name) : `© ${PRODUCT.name}`}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
