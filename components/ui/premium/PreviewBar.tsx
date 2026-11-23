/*
 * BOUNDARY (module 7, shared UI, NEW v4, v5 additions). Inputs: PreviewBar {label? (default "Preview, sample data, nothing is saved"), shortLabel? (v5: a shorter visible text for phones), controls? (the trigger slot), className, data-testid}.
 * Output: ONE slim 28 px full-width strip that holds the preview tag and a slot for the "Preview controls" trigger, so the page title row stays clean (no yellow pill, no button beside the heading). Preview furniture is not product UI:
 * muted text on a quiet grey, 12 px. Any Button put in the slot, including a Popover or Menu trigger, is drawn as a 24 px text button with a 48 px hit area. The first word of a label that starts with "Preview" is set a little heavier.
 * v5: under 640 px the label WRAPS onto a second short line instead of being cut with an ellipsis (the bar grows to fit); with shortLabel the phone shows the short text and the full label stays in the page for assistive technology, and the group is named by the full label.
 * Must not change: it is a role="group" named by its label (not a landmark, so it never breaks the one-main-landmark rule); it holds no state and does nothing itself; it is for preview builds only and must not ship in a real product screen.
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export const PREVIEW_LABEL = "Preview, sample data, nothing is saved";
/** v5: a phone-sized form of PREVIEW_LABEL for the shortLabel prop. */
export const PREVIEW_SHORT_LABEL = "Preview, sample data";

export interface PreviewBarProps {
  label?: string;
  /** v5: shown instead of label under 640 px. The full label stays readable by assistive technology and names the group. */
  shortLabel?: string;
  controls?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

function tagged(text: string): ReactNode {
  return text.startsWith("Preview") ? <><span className={styles.pbarTag}>Preview</span>{text.slice("Preview".length)}</> : text;
}

export function PreviewBar({ label = PREVIEW_LABEL, shortLabel, controls, className, ...rest }: PreviewBarProps) {
  return (
    <div role="group" aria-label={shortLabel ? label : "Preview information"} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.pbar, className)}>
      <span className={cx(styles.pbarText, shortLabel && styles.pbarHasShort)}>
        {shortLabel ? (
          <>
            <span className={styles.pbarFull}>{tagged(label)}</span>
            <span className={styles.pbarShort} aria-hidden="true">{tagged(shortLabel)}</span>
          </>
        ) : tagged(label)}
      </span>
      {controls ? <span className={styles.pbarSlot}>{controls}</span> : null}
    </div>
  );
}
