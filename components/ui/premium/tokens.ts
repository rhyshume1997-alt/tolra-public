/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: none. Output: the class that carries the design tokens and the list of token names.
 * Must not change: token names (every later module reads them); values live in premium.module.css under .tokens. Apply
 * `premiumTokens` to a page root AND to any portal layer you create yourself, because a portal sits outside the root's DOM subtree.
 * No business rules, no data, no imports other than the one CSS module.
 */
import styles from "./premium.module.css";

/** Class that defines every --ui-* custom property plus the Archivo base font. */
export const premiumTokens: string = styles.tokens;
/** Archivo tabular figures: put on any element that holds a figure in a column or counter. */
export const tabularNumbers: string = styles.num;
/** Visually hidden but read by assistive technology. */
export const srOnly: string = styles.srOnly;

/** The documented token names (see premium.module.css). */
export const TOKEN_NAMES = [
  "--ui-brand", "--ui-accent", "--ui-on-brand", "--ui-ink", "--ui-ink-2", "--ui-muted", "--ui-line", "--ui-line-strong", "--ui-line-hover",
  "--ui-surface", "--ui-surface-2", "--ui-surface-3", "--ui-soft", "--ui-danger", "--ui-danger-soft", "--ui-warn", "--ui-warn-soft",
  "--ui-ok", "--ui-ok-soft", "--ui-info", "--ui-info-soft", "--ui-neutral", "--ui-neutral-soft", "--ui-radius-sm", "--ui-radius-md",
  "--ui-radius-lg", "--ui-shadow-1", "--ui-shadow-pop", "--ui-shadow-dialog", "--ui-inset-light", "--ui-inset-dark", "--ui-ease",
  "--ui-t-fast", "--ui-t-base", "--ui-t-slow", "--ui-h-sm", "--ui-h-md", "--ui-h-lg", "--ui-font",
] as const;

/** Joins class names, skipping anything falsy. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
