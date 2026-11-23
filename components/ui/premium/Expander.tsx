"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v5). Inputs: ExpanderButton {expanded, onToggle, label (the accessible name, for example "Show details for J-0431"), controls? (id of the region it opens), disabled?, className, data-testid}.
 * Output: the 48 x 48 px icon-only button (Button size "icon", quiet) with a chevron that turns when expanded; aria-expanded and the name carry the state for assistive technology, so the chevron is a functional mark, not decoration.
 * Must not change: it is controlled (the caller owns expanded and what opens); it fetches and saves nothing; the name is a real sentence for the row it acts on, never just "Expand".
 */
import styles from "./premium.module.css";
import { Button } from "./Button";
import { cx } from "./tokens";

export interface ExpanderButtonProps {
  expanded: boolean;
  onToggle: () => void;
  label: string;
  controls?: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function ExpanderButton({ expanded, onToggle, label, controls, disabled, className, ...rest }: ExpanderButtonProps) {
  return (
    <Button size="icon" variant="quiet" aria-label={label} aria-expanded={expanded} aria-controls={controls} disabled={disabled} onClick={onToggle} className={cx(className)} data-testid={rest["data-testid"]}>
      <svg className={styles.expChevron} width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.6 5 6.6 8 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </Button>
  );
}
