"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v2). Inputs: StatTile {label, value, hint?, delta?, deltaTone?, loading?, onPress?, pressed?}; StatTiles {label, columns?, children}.
 * Output: a KPI tile: a label, ONE figure in tabular numerals, an optional hint line and an optional delta given as WORDS ("Up 4 on last week"; deltaTone only tints the words, it is never the only signal).
 * No chart, no sparkline, no icon, no dot. While loading the figure is an em dash and assistive technology hears "Loading", so a tile never shows a stale or invented number.
 * With onPress it is a toggle button (aria-pressed) for filtering the list below it; without it, it is plain text. StatTiles groups tiles (role=group, 4 columns, 2 under 1100 px).
 * v3 (all optional; without them the output is exactly v2): href makes the tile a link (an <a>; pass onClick for a client-side navigation or a preview toast), status + statusTone add a dot-and-word status line
 * (the word is the signal, the dot only repeats it), definition is a plain-words explanation of the figure: it shows as a hover tooltip AND is read by screen readers as the tile's description.
 * Must not change: it computes nothing: the caller passes the formatted figure and words (money, counts and rules live in the caller's lib).
 */
import { useId, type MouseEventHandler, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens, srOnly, tabularNumbers } from "./tokens";
import { StatusBadge, type StatusTone } from "./StatusBadge";

export interface StatTileProps {
  /** A string, or (v3) a node when the label needs a small mark of its own, for example a coloured dot; the figure and hint stay plain text. */
  label: ReactNode;
  value: ReactNode;
  hint?: string;
  delta?: string;
  deltaTone?: "neutral" | "ok" | "warn" | "danger";
  loading?: boolean;
  /** Makes the tile a toggle button. The caller decides what pressing it filters. */
  onPress?: () => void;
  pressed?: boolean;
  /** v3: makes the tile a link. */
  href?: string;
  /** v3: click handler for the link form (the tile still has its href for new tab and copy link). */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  /** v3: a status in words, drawn as dot plus word. */
  status?: string;
  statusTone?: StatusTone;
  /** v3: what the figure means, in plain words (hover text and screen reader description). */
  definition?: string;
  className?: string;
  "data-testid"?: string;
}

export function StatTile({ label, value, hint, delta, deltaTone = "neutral", loading, onPress, pressed, href, onClick, status, statusTone = "neutral", definition, className, ...rest }: StatTileProps) {
  const defId = useId();
  const described = definition ? defId : undefined;
  const inner = (
    <>
      <span className={styles.tileLabel}>{label}</span>
      <span className={cx(styles.tileValue, tabularNumbers)}>
        {loading ? (<><span aria-hidden="true">—</span><span className={srOnly}>Loading</span></>) : value}
      </span>
      {!loading && hint ? <span className={styles.tileHint}>{hint}</span> : null}
      {!loading && delta ? <span className={cx(styles.tileDelta, deltaTone !== "neutral" && styles[`tileDelta_${deltaTone}`])}>{delta}</span> : null}
      {!loading && status ? <span className={styles.tileStatus}><StatusBadge tone={statusTone} plain>{status}</StatusBadge></span> : null}
      {definition ? <span id={defId} className={srOnly}>{definition}</span> : null}
    </>
  );
  if (href && !onPress) {
    return (
      <a href={href} onClick={onClick} title={definition} aria-describedby={described} aria-busy={loading || undefined} data-testid={rest["data-testid"]}
        className={cx(premiumTokens, styles.tile, styles.tilePress, styles.tileLink, className)}>
        {inner}
      </a>
    );
  }
  if (onPress) {
    return (
      <button type="button" aria-pressed={!!pressed} disabled={loading} aria-busy={loading || undefined} data-testid={rest["data-testid"]} onClick={onPress} title={definition} aria-describedby={described}
        className={cx(premiumTokens, styles.tile, styles.tilePress, className)}>
        {inner}
      </button>
    );
  }
  return <div aria-busy={loading || undefined} title={definition} aria-describedby={described} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.tile, className)}>{inner}</div>;
}

export function StatTiles({ label, columns = 4, children, className }: { label: string; columns?: 1 | 2 | 3 | 4; children: ReactNode; className?: string }) {
  return <div role="group" aria-label={label} className={cx(premiumTokens, styles.tiles, className)} style={{ ["--cols" as string]: columns }}>{children}</div>;
}
