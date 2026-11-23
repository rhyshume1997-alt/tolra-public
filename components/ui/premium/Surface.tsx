/*
 * BOUNDARY (module 7, shared UI, NEW v3). Inputs: Panel {title?, headingLevel (2 to 6, default 2), actions?, bare?, className, children}; Callout {tone (neutral | info | warn | error), lead?, action?, role?, className, children}.
 * Output: Panel is a white 14 px card (a <section>, named by its heading when it has a title) with a heading you place in your page's outline (headingLevel), an actions slot beside the title, and a body;
 * bare removes the body padding (for a table or list that fills the card). Callout is a notice: a left bar AND words, never colour alone. lead is the bold lead-in word (info "Note", warn "Warning", error "Problem" by default;
 * neutral has none; pass lead="" to drop it). No icon, no dismiss, no animation. An error callout is role="alert"; pass role to change that (or role="status" for a live info or warn message).
 * v4 (optional): Panel takes variant ("raised" default | "flat" = hairline only, no shadow | "nested" = no card at all: no background, border or shadow, just a hairline above, so a Panel inside a Panel is never a card in a card) and nested (shorthand for variant="nested").
 * Panel title is the card style of the type scale (15/22, weight 600); Callout text is the body style (14/20) and its lead word weight 600.
 * Panel also takes label (an aria-label for a titled-less panel, so it still reads as a named region) and busy (aria-busy while its content loads).
 * Must not change: neither holds data or rules (the caller writes the words); the tones are the four listed; no gradients, no shadows beyond the card's; Panel never hides its heading from assistive technology.
 */
import { useId, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";
import type { HeadingLevel } from "./StatePanels";

const tag = (n: HeadingLevel) => `h${n}` as "h2" | "h3" | "h4" | "h5" | "h6";

export type PanelVariant = "raised" | "flat" | "nested";

export interface PanelProps {
  title?: string;
  headingLevel?: HeadingLevel;
  actions?: ReactNode;
  bare?: boolean;
  /** v4: raised (default card with a soft shadow), flat (hairline only) or nested (no card chrome; for a panel inside a panel). */
  variant?: PanelVariant;
  /** v4: shorthand for variant="nested". */
  nested?: boolean;
  /** Names an untitled panel for assistive technology (ignored when there is a title). */
  label?: string;
  busy?: boolean;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}

export function Panel({ title, headingLevel = 2, actions, bare, variant, nested, label, busy, className, children, ...rest }: PanelProps) {
  const id = useId();
  const kind: PanelVariant = nested ? "nested" : variant ?? "raised";
  const H = tag(headingLevel);
  return (
    <section aria-labelledby={title ? `${id}-t` : undefined} aria-label={title ? undefined : label} aria-busy={busy || undefined} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.panel, kind === "flat" && styles.panelFlat, kind === "nested" && styles.panelNested, bare && styles.panelBare, !title && !actions && styles.panelNoTitle, className)}>
      {title || actions ? (
        <div className={styles.panelHead}>
          {title ? <H id={`${id}-t`} className={styles.panelTitle}>{title}</H> : <span />}
          {actions}
        </div>
      ) : null}
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

export type CalloutTone = "neutral" | "info" | "warn" | "error";
const DEFAULT_LEAD: Record<CalloutTone, string> = { neutral: "", info: "Note", warn: "Warning", error: "Problem" };

/** Pure: the lead-in word for a tone (exported for tests). An explicit lead (including "") wins. */
export function calloutLead(tone: CalloutTone, lead?: string): string {
  return lead ?? DEFAULT_LEAD[tone];
}

export interface CalloutProps {
  tone?: CalloutTone;
  lead?: string;
  action?: ReactNode;
  role?: "alert" | "status" | "note";
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}

export function Callout({ tone = "info", lead, action, role, className, children, ...rest }: CalloutProps) {
  const word = calloutLead(tone, lead);
  return (
    <div role={role ?? (tone === "error" ? "alert" : undefined)} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.callout, styles[`callout_${tone}`], className)}>
      <div className={styles.calloutText}>
        {word ? <strong className={styles.calloutLead}>{word}: </strong> : null}
        {children}
      </div>
      {action ? <div className={styles.calloutAction}>{action}</div> : null}
    </div>
  );
}
