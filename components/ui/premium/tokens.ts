/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: none. Output: the class that carries the design tokens and the list of token names.
 * v4 (additive): ./fonts (IBM Plex Sans 400, 500, 600 from @fontsource, scoped to .tokens only), font tokens (--ui-font, --ui-font-heading, --ui-font-numeric: one place to swap the family), typeScale (class names for the nine text styles: page, section, card, label, body, name, secondary, caption, tableHead, numeral), the new token names (type scale, elevation, motion) and pressScale.
 * Must not change: token names (every later module reads them); values live in premium.module.css under .tokens. Apply
 * `premiumTokens` to a page root AND to any portal layer you create yourself, because a portal sits outside the root's DOM subtree.
 * No business rules, no data, no imports other than the one CSS module.
 */
import "./fonts";
import styles from "./premium.module.css";

/** Class that defines every --ui-* custom property plus the IBM Plex Sans base font. */
export const premiumTokens: string = styles.tokens;
/** Tabular figures: put on any element that holds a figure in a column or counter. */
export const tabularNumbers: string = styles.num;
/** Visually hidden but read by assistive technology. */
export const srOnly: string = styles.srOnly;

/**
 * v4: the type scale as class names. page 26/32 650, section 18/24 600, card 15/22 600, label 13/18 600, body 14/20 400, name 14/20 600 (a name or title inside a row),
 * secondary 13/18 400 muted, caption 12/16 500 muted, tableHead 12/16 600 uppercase tracked, numeral 28/32 600 tabular (24/28 under 640 px).
 */
export const typeScale = {
  page: styles.tPage, section: styles.tSection, card: styles.tCard, label: styles.tLabel, body: styles.tBody, name: styles.tName,
  secondary: styles.tSecondary, mono: styles.tMono, caption: styles.tCaption, tableHead: styles.tTableHead, numeral: styles.tNumeral,
} as const;

/** The documented token names (see premium.module.css). */
export const TOKEN_NAMES = [
  "--ui-brand", "--ui-accent", "--ui-on-brand", "--ui-ink", "--ui-ink-2", "--ui-muted", "--ui-line", "--ui-line-strong", "--ui-line-hover",
  "--ui-surface", "--ui-surface-2", "--ui-surface-3", "--ui-soft", "--ui-danger", "--ui-danger-soft", "--ui-warn", "--ui-warn-soft",
  "--ui-ok", "--ui-ok-soft", "--ui-info", "--ui-info-soft", "--ui-neutral", "--ui-neutral-soft", "--ui-radius-sm", "--ui-radius-md",
  "--ui-radius-lg", "--ui-shadow-1", "--ui-shadow-pop", "--ui-shadow-dialog", "--ui-inset-light", "--ui-inset-dark", "--ui-ease",
  "--ui-t-fast", "--ui-t-base", "--ui-t-slow", "--ui-h-sm", "--ui-h-md", "--ui-h-lg", "--ui-font",
  // v2 (added, none renamed): hit box, sheet widths, toast offsets.
  "--ui-hit", "--ui-sheet-sm", "--ui-sheet-md", "--ui-sheet-lg", "--ui-toast-top", "--ui-toast-edge",
  // v4 (added, none renamed): motion curves and durations, press scale, elevation levels, type scale (size, line height, weight, tracking per style).
  "--ui-ease-out", "--ui-ease-in-out", "--ui-t-sheet", "--ui-t-exit", "--ui-press", "--ui-press-lg",
  "--ui-elev-flat", "--ui-elev-raised", "--ui-elev-overlay", "--ui-elev-modal",
  "--ui-fs-page", "--ui-lh-page", "--ui-fw-page", "--ui-ls-page", "--ui-fs-section", "--ui-lh-section", "--ui-fw-section", "--ui-ls-section",
  "--ui-fs-card", "--ui-lh-card", "--ui-fw-card", "--ui-ls-card", "--ui-fs-label", "--ui-lh-label", "--ui-fw-label", "--ui-ls-label",
  "--ui-fs-body", "--ui-lh-body", "--ui-fw-body", "--ui-ls-body", "--ui-fs-secondary", "--ui-lh-secondary", "--ui-fw-secondary", "--ui-ls-secondary",
  "--ui-fs-caption", "--ui-lh-caption", "--ui-fw-caption", "--ui-ls-caption", "--ui-fs-thead", "--ui-lh-thead", "--ui-fw-thead", "--ui-ls-thead",
  "--ui-fs-numeral", "--ui-lh-numeral", "--ui-fw-numeral", "--ui-ls-numeral", "--ui-fw-name",
  // v4 font indirection: the family is defined once; the override variables are optional and unset by default.
  "--ui-font-heading", "--ui-font-numeric", "--ui-font-mono", "--ui-numeric-features",
] as const;

/** Joins class names, skipping anything falsy. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
