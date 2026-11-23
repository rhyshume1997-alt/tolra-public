/*
 * BOUNDARY (module 7, shared UI, NEW v4). Inputs: PreviewBar {label? (default "Preview, sample data, nothing is saved"), controls? (the trigger slot), className, data-testid}.
 * Output: ONE slim 28 px full-width strip that holds the preview tag and a slot for the "Preview controls" trigger, so the page title row stays clean (no yellow pill, no button beside the heading). Preview furniture is not product UI:
 * muted text on a quiet grey, 12 px. Any Button put in the slot, including a Popover or Menu trigger, is drawn as a 24 px text button with a 48 px hit area. The first word of a label that starts with "Preview" is set a little heavier.
 * Must not change: it is a role="group" named by its label (not a landmark, so it never breaks the one-main-landmark rule); it holds no state and does nothing itself; it is for preview builds only and must not ship in a real product screen.
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export const PREVIEW_LABEL = "Preview, sample data, nothing is saved";

export interface PreviewBarProps {
  label?: string;
  controls?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function PreviewBar({ label = PREVIEW_LABEL, controls, className, ...rest }: PreviewBarProps) {
  const tagged = label.startsWith("Preview");
  return (
    <div role="group" aria-label="Preview information" data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.pbar, className)}>
      <span className={styles.pbarText}>{tagged ? <><span className={styles.pbarTag}>Preview</span>{label.slice("Preview".length)}</> : label}</span>
      {controls ? <span className={styles.pbarSlot}>{controls}</span> : null}
    </div>
  );
}
