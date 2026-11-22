/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: tone (neutral | info | progress | warn | ok | danger) and the word as children.
 * Output: one grammar for status everywhere: a 7 px dot plus the word, on a quiet tint (or plain). Colour is never the only signal.
 * Must not change: the word is required (no dot-only badge); the dot is aria-hidden because the word carries the meaning.
 * Tone to meaning is the caller's decision (no job, quote or invoice rules live here).
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export type StatusTone = "neutral" | "info" | "progress" | "warn" | "ok" | "danger";

export function StatusBadge({ tone = "neutral", children, plain, className }: { tone?: StatusTone; children: ReactNode; plain?: boolean; className?: string }) {
  return (
    <span className={cx(premiumTokens, styles.badge, styles[`t_${tone}`], plain && styles.badgePlain, className)}>
      <span className={styles.badgeDot} aria-hidden="true" />
      {children}
    </span>
  );
}
