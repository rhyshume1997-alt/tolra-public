/*
 * BOUNDARY (module 7, shared UI, NEW v4). Inputs: PageHeader {title, description?, actions?, headingLevel (1 to 6, default 1), className, data-testid}.
 * Output: the top of a screen with the right scale: the title in the page style (26/32, weight 650; 22/28 under 640 px), an optional one-line description under it (14/20, weight 400, at most 64 characters wide), and an optional
 * actions slot on the right (it wraps under the text on a narrow screen, rows 16 px apart so 48 px hit areas never overlap). One heading only: the title. The description is a paragraph, not a heading.
 * Must not change: it holds no data and no rules (the caller writes the words and passes the buttons); it never hides the title; it adds no preview tag (that is PreviewBar's job, above the page).
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
  "data-testid"?: string;
}

export function PageHeader({ title, description, actions, headingLevel = 1, className, ...rest }: PageHeaderProps) {
  const H = `h${headingLevel}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <header className={cx(premiumTokens, styles.ph, className)} data-testid={rest["data-testid"]}>
      <div className={styles.phText}>
        <H className={styles.phTitle}>{title}</H>
        {description ? <p className={styles.phDesc}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.phActions}>{actions}</div> : null}
    </header>
  );
}
