"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: variant (primary | secondary | quiet; v3 adds the destructive set danger = red outline for the first step, dangerSolid = red fill for the final
 * confirm, dangerQuiet = red text for a row action), size (sm 32 | md 40 | lg 48), loading, onDark, fullWidth (v3: block, 100% wide; use size lg + primary for a full-width form action),
 * and every native button attribute. Output: a <button> with a 48 px hit area (a pseudo element reaches 48 px tall on sm and md). v3: aria-pressed="true" on secondary or quiet draws the
 * navy pressed look from the stylesheet itself (no override needed).
 * Must not change: the three heights are the whole system, the non-destructive variants stay primary, secondary, quiet (danger is for destroying or removing only). It never performs an
 * action itself and never shows success: the caller's onClick decides. Inside a SelectionBar the on-dark look is picked up from OnDarkContext. Defaults are exactly v1/v2.
 */
import { createContext, forwardRef, useContext, type ButtonHTMLAttributes } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "dangerSolid" | "dangerQuiet";
export type ButtonSize = "sm" | "md" | "lg";

/** Set by SelectionBar so buttons placed on the navy bar read correctly. */
export const OnDarkContext = createContext(false);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks. The caller still has to report the real outcome. */
  loading?: boolean;
  onDark?: boolean;
  /** v3: fills the width of its parent (display block). */
  fullWidth?: boolean;
}

const sizeClass: Record<ButtonSize, string> = { sm: styles.sizeSm, md: styles.sizeMd, lg: styles.sizeLg };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, onDark, fullWidth, className, children, disabled, type = "button", ...rest },
  ref,
) {
  const ctxDark = useContext(OnDarkContext);
  const dark = onDark ?? ctxDark;
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(premiumTokens, styles.btn, styles[variant], sizeClass[size], dark && styles.onDark, fullWidth && styles.btnBlock, className)}
    >
      {loading ? <span className={styles.busyDot} aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
