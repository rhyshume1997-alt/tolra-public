"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v3). Inputs: Disclosure {summary (the always-visible line), children, defaultOpen?, open?, onToggle?(open), className}.
 * Output: the native <details> and <summary>, styled: a 48 px summary row (the whole row is the target) with a chevron that turns when open, then the content. Native behaviour is kept on purpose:
 * Enter and Space toggle it, find-in-page can open it, and assistive technology announces expanded or collapsed without any ARIA of ours.
 * Must not change: it is uncontrolled unless you pass open (then you own it through onToggle); the summary text must say what is inside; it hides nothing that must be seen (an error never lives only inside a closed one).
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
  "data-testid"?: string;
}

export function Disclosure({ summary, children, defaultOpen, open, onToggle, className, ...rest }: DisclosureProps) {
  return (
    <details
      className={cx(premiumTokens, styles.disc, className)}
      open={open ?? defaultOpen}
      data-testid={rest["data-testid"]}
      onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}
    >
      <summary className={styles.discSummary}>
        <span className={styles.discText}>{summary}</span>
        <svg className={styles.discChevron} width="12" height="12" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.6 5 6.6 8 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </summary>
      <div className={styles.discBody}>{children}</div>
    </details>
  );
}
