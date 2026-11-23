/*
 * BOUNDARY (module 7, shared UI, NEW v4). Inputs: StackedRows {label, rows[{id, title, status?, fields[{label, value}], actions?, href?, onClick?, testId?}], narrowOnly?, className, data-testid}.
 * Output: the narrow screen form of a table: a list with one record per row. Each row has the name (card style, 15/22 weight 600) with an optional status beside it, then label and value pairs (labels muted 13 px, values 14 px) in a definition list,
 * then an actions row (16 px between wrapped rows so 48 px hit areas never overlap). With href the title is the link and its hit area covers the row; actions stay separately clickable. narrowOnly shows it only under 640 px (pair it with
 * <ScrollTable narrowHidden>); without it, it always shows. No selection, sorting or data of its own.
 * Must not change: values are passed in already formatted (money, dates and rules live in the caller); every label is a word; a row with only onClick is not made clickable (use href or put a real button in actions).
 */
import type { MouseEventHandler, ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export interface StackedField { label: string; value: ReactNode }
export interface StackedRow {
  id: string;
  title: ReactNode;
  status?: ReactNode;
  fields: StackedField[];
  actions?: ReactNode;
  href?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
}

export interface StackedRowsProps {
  label: string;
  rows: StackedRow[];
  narrowOnly?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function StackedRows({ label, rows, narrowOnly, className, ...rest }: StackedRowsProps) {
  return (
    <ul aria-label={label} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.stack, narrowOnly && styles.stackNarrow, className)}>
      {rows.map((r) => (
        <li key={r.id} data-link={r.href ? "true" : undefined} data-testid={r.testId} className={styles.stackRow}>
          <div className={styles.stackHead}>
            <span className={styles.stackTitle}>{r.href ? <a href={r.href} onClick={r.onClick} className={styles.stackLink}>{r.title}</a> : r.title}</span>
            {r.status ? <span className={styles.stackStatus}>{r.status}</span> : null}
          </div>
          <dl className={styles.stackFields}>
            {r.fields.map((f) => (
              <Pair key={f.label} label={f.label} value={f.value} />
            ))}
          </dl>
          {r.actions ? <div className={styles.stackActions}>{r.actions}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function Pair({ label, value }: StackedField) {
  return (<><dt>{label}</dt><dd>{value}</dd></>);
}
