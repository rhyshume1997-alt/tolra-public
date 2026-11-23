/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: tone (neutral | info-neutral | info | progress | warn | ok | danger), the word as children, mode ("pill" default | "text"), plain (old name for text-without-size-change, kept), className.
 * Output: one grammar for status everywhere: a 7 px dot plus the word. mode "pill" is the quiet tinted chip (v4: a lighter rim than before); mode "text" drops the chip, so a row whose column already says it only shows dot and word (13 px, weight 500).
 * tone "info-neutral" is a cool slate for "records exist" or "n linked": not green (nothing is good or done) and not amber (nothing needs a look). Colour is never the only signal.
 * Must not change: the word is required (no dot-only badge); the dot is aria-hidden because the word carries the meaning.
 * Tone to meaning is the caller's decision (no job, quote or invoice rules live here).
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export type StatusTone = "neutral" | "info-neutral" | "info" | "progress" | "warn" | "ok" | "danger";
export type StatusMode = "pill" | "text";

/** Pure: the stylesheet class key for a tone (exported for tests). The hyphen is not valid in a CSS module key, so info-neutral is infoNeutral. */
export function toneClassKey(tone: StatusTone): string {
  return tone === "info-neutral" ? "t_infoNeutral" : `t_${tone}`;
}

export function StatusBadge({ tone = "neutral", children, plain, mode = "pill", className }: { tone?: StatusTone; children: ReactNode; plain?: boolean; mode?: StatusMode; className?: string }) {
  return (
    <span className={cx(premiumTokens, styles.badge, styles[toneClassKey(tone)], plain && styles.badgePlain, mode === "text" && styles.badgeText, className)}>
      <span className={styles.badgeDot} aria-hidden="true" />
      {children}
    </span>
  );
}
