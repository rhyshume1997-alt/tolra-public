import { useId } from "react";

/**
 * The Tolra mark as inline SVG, traced from public/brand/tolra-icon-flat.png (same bracket and T geometry, 1024 grid).
 * "full" gives the T a faint paper sheen like the textured logo; "flat" is plain colour, for small sizes. No background.
 * `bracket` and `ink` recolour the brackets and the T (defaults: signal blue brackets, white T, for dark grounds); the public
 * pages draw it in one navy ink on the paper.
 */
export function BracketT({ variant = "flat", size = 32, className, title, bracket = "#1e8fff", ink = "#ffffff" }: { variant?: "full" | "flat"; size?: number; className?: string; title?: string; bracket?: string; ink?: string }) {
  const id = useId();
  const t = variant === "full" ? `url(#${id}-t)` : ink;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="150 150 724 724" width={size} height={size} className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      {variant === "full" ? (
        <defs>
          <linearGradient id={`${id}-t`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#eceef6" />
          </linearGradient>
        </defs>
      ) : null}
      <g fill={bracket}>
        <path d="M180 180h233v59H239v547h174v59H180z" />
        <path d="M845 180H612v59h174v547H612v59h233z" />
      </g>
      <path d="M285 265h455v114H576v402H449V379H285z" fill={t} />
    </svg>
  );
}
