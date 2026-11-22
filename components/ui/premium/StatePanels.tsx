/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: EmptyState {title, detail?, action?}; LoadingState {label, rows?}; FailedState {title, detail, onRetry, retryLabel?}.
 * Output: three honest panels (min 160 px high). Failed has a red bar and role="alert"; Loading is role="status" with aria-busy and a shimmer
 * that stops under reduced motion; Empty carries one next step.
 * v2: EmptyState and FailedState take headingLevel (2 to 6, default 3 = the old output) so a page can match its own outline and pass the heading-order check.
 * Must not change: they show no numbers and no sample data, and FailedState only calls onRetry: it never pretends a retry worked.
 * A page showing one of these must hide or zero its own counters so the page never contradicts itself.
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { Button } from "./Button";
import { cx, premiumTokens } from "./tokens";

export type HeadingLevel = 2 | 3 | 4 | 5 | 6;
const tag = (n: HeadingLevel) => `h${n}` as "h2" | "h3" | "h4" | "h5" | "h6";

export function EmptyState({ title, detail, action, headingLevel = 3 }: { title: string; detail?: string; action?: ReactNode; headingLevel?: HeadingLevel }) {
  const H = tag(headingLevel);
  return (
    <section className={cx(premiumTokens, styles.state, styles.stateEmpty)} aria-label={title}>
      <H className={styles.stateTitle}>{title}</H>
      {detail ? <p className={styles.stateText}>{detail}</p> : null}
      {action}
    </section>
  );
}

export function LoadingState({ label, rows = 4 }: { label: string; rows?: number }) {
  const widths = ["92%", "78%", "86%", "64%", "72%", "58%"];
  return (
    <section className={cx(premiumTokens, styles.state)} role="status" aria-busy="true" aria-label={label}>
      <p className={styles.stateTitle}>{label}</p>
      <div className={styles.skel} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => <i key={i} className={styles.skelRow} style={{ width: widths[i % widths.length] }} />)}
      </div>
    </section>
  );
}

export function FailedState({ title, detail, onRetry, retryLabel = "Try again", headingLevel = 3 }: { title: string; detail: string; onRetry?: () => void; retryLabel?: string; headingLevel?: HeadingLevel }) {
  const H = tag(headingLevel);
  return (
    <section className={cx(premiumTokens, styles.state, styles.stateFailed)} role="alert">
      <H className={styles.stateTitle}>{title}</H>
      <p className={styles.stateText}>{detail}</p>
      {onRetry ? <Button variant="secondary" onClick={onRetry}>{retryLabel}</Button> : null}
    </section>
  );
}
