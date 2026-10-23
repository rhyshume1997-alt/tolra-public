/**
 * The product's own name, in one place. Change it here to rebrand the app (sign-in page, sidebar, page titles,
 * installed-app name and icon, emails, offline page). Company names and logos are separate: they come from each
 * organisation's settings, and on a company's own screens the product only appears as a small credit.
 */
export const PRODUCT = {
  name: "Tolra",
  shortName: "Tolra",
  tagline: "Quotes, jobs and invoices for engineering workshops.",
  /** Letter(s) on the neutral app icon and in the sidebar when no company logo is set. */
  monogram: "T",
  /** Neutral colours (#rrggbb), used when a company hasn't set its own. */
  primary: "#1E3472",
  accent: "#2E52B8",
  /** Installed-app background and theme colour (matches the app icon). */
  appTheme: "#0b1626",
} as const;

/** "JNR Engineering Ltd · Tolra": a company's name first, the product as a small credit. */
export const withProductCredit = (companyName: string) => `${companyName} · ${PRODUCT.name}`;
