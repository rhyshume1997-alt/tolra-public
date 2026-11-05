"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The ONE card frame for Admin > Integrations (AI, Xero, Microsoft 365, Resend): identical layout, so every card reads the same way.
 *   1. a title and one plain sentence;
 *   2. CONNECTION: whether the account is signed in / the key is saved. Connected only means signed in. It never means "allowed to transfer".
 *   3. numbered setup steps (done / next / later);
 *   4. the card's own actions (children);
 *   5. ACTIVATION: a SEPARATE switch, OFF by default, with its own words. Turning it on is its own step (needs the authorised role and a recent
 *      MFA code where the card says so). When the server cannot allow it (emergency disable, missing release, not set up) the switch is disabled
 *      and says why.
 * No data fetching, no secrets: a card passes in plain strings and callbacks.
 */
export type StepState = "done" | "next" | "later";
export type SetupStep = { label: string; state: StepState; hint?: string };
export type ConnectionTone = "off" | "working" | "attention" | "ok";
export type Activation = {
  /** e.g. "Turn on AI" / "Turn on transfers to Xero". */
  label: string;
  /** The current state, as the server reports it. null = unknown (shown as "Unknown", never as on). */
  on: boolean | null;
  /** Why the switch cannot be used now; when set the switch is disabled. */
  disabledReason?: string | null;
  busy?: boolean;
  onChange?: (next: boolean) => void;
  /** Words under the switch (what turning it on does). */
  help?: string;
};

export function SetupCard(props: {
  id: string;
  title: string;
  summary: string;
  connection: { tone: ConnectionTone; label: string };
  steps: SetupStep[];
  activation: Activation;
  children?: ReactNode;
  /** A note about the server emergency disable or other fixed rules. */
  footnote?: string;
}) {
  const { id, title, summary, connection, steps, activation, children, footnote } = props;
  const toneClass = { off: "text-slate-600", working: "text-slate-700", attention: "text-amber-800", ok: "text-emerald-800" }[connection.tone];
  const disabled = Boolean(activation.disabledReason) || activation.busy || !activation.onChange;
  const stateWord = activation.on === null ? "Unknown" : activation.on ? "On" : "Off";
  return (
    <Card data-testid={`setup-card-${id}`} aria-labelledby={`setup-title-${id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle id={`setup-title-${id}`}>{title}</CardTitle>
          <Badge variant="outline" data-testid={`activation-badge-${id}`}>{activation.label.replace(/^Turn on /, "")}: {stateWord}</Badge>
        </div>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <p data-testid={`connection-${id}`}><span className="font-medium">Connection: </span><span className={toneClass}>{connection.label}</span></p>
        <ol className="grid gap-1" aria-label={`${title} setup steps`}>
          {steps.map((step, index) => (
            <li key={step.label} data-state={step.state} className={step.state === "later" ? "text-slate-400" : step.state === "done" ? "text-slate-700" : "font-medium"}>
              <span aria-hidden="true">{step.state === "done" ? "✓ " : `${index + 1}. `}</span>{step.label}
              {step.hint ? <span className="block pl-5 text-xs font-normal text-slate-500">{step.hint}</span> : null}
            </li>
          ))}
        </ol>
        {children ? <div className="grid gap-2">{children}</div> : null}
        <div className="grid gap-1 rounded-md border p-3" data-testid={`activation-${id}`}>
          <div className="flex items-center justify-between gap-3">
            <span id={`activation-label-${id}`} className="font-medium">{activation.label}</span>
            <button
              type="button"
              role="switch"
              aria-checked={activation.on === true}
              aria-labelledby={`activation-label-${id}`}
              disabled={disabled}
              onClick={() => activation.onChange?.(!(activation.on === true))}
              className={`h-6 w-11 rounded-full border transition-colors disabled:opacity-50 ${activation.on ? "bg-emerald-600" : "bg-slate-200"}`}
            >
              <span className={`block size-5 rounded-full bg-white shadow transition-transform ${activation.on ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </div>
          {activation.help ? <p className="text-xs text-slate-500">{activation.help}</p> : null}
          {activation.disabledReason ? <p className="text-xs text-amber-800" data-testid={`activation-why-${id}`}>{activation.disabledReason}</p> : null}
        </div>
        {footnote ? <p className="text-xs text-slate-500">{footnote}</p> : null}
      </CardContent>
    </Card>
  );
}
