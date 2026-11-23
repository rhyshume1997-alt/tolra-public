/*
 * BOUNDARY (module 7, shared UI, NEW v3). Inputs: List {label?, dense?, plain?, className, children (ListRow items)}; ListRow {title, meta?, leading?, trailing?, href?, onClick?, className, children?}.
 * Output: a <ul> of rows with hairline separators. Each ListRow is an <li> at least 56 px high (48 when the list is dense) with a main block (title, then a muted meta line, then any children), an optional leading
 * slot and a trailing slot for actions. With href the title is the link and its hit area covers the whole row (stretched link); controls in trailing stay separately clickable. 16 px between wrapped trailing controls.
 * Must not change: it is plain markup (no data, no selection, no sorting); a row with only an onClick is NOT made clickable (use a real link or button: pointer-only rows are not keyboard reachable).
 */
import type { MouseEventHandler, ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export function List({ label, dense, plain, className, children, ...rest }: { label?: string; dense?: boolean; plain?: boolean; className?: string; children: ReactNode; "data-testid"?: string }) {
  return <ul aria-label={label} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.list, dense && styles.listDense, plain && styles.listPlain, className)}>{children}</ul>;
}

export interface ListRowProps {
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
}

export function ListRow({ title, meta, leading, trailing, href, onClick, className, children, ...rest }: ListRowProps) {
  return (
    <li data-link={href ? "true" : undefined} data-testid={rest["data-testid"]} className={cx(styles.listRow, className)}>
      {leading ? <div className={styles.rowLead}>{leading}</div> : null}
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{href ? <a href={href} onClick={onClick} className={styles.rowLink}>{title}</a> : title}</span>
        {meta ? <span className={styles.rowMeta}>{meta}</span> : null}
        {children}
      </div>
      {trailing ? <div className={styles.rowTrailing}>{trailing}</div> : null}
    </li>
  );
}
