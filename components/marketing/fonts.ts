import localFont from "next/font/local";

/**
 * The public pages' faces, served from this site: the files are committed under ./fonts-files, so a build never downloads anything
 * (the Google Fonts download failed CI builds on #194 and #229). Same faces and weights as before; the CSP allows fonts from 'self' only.
 * Headings: Barlow Condensed (DIN-like drawing lettering). Body: IBM Plex Sans. Job and part numbers, revs and dates: IBM Plex Mono.
 * The app's own pages keep their fonts (app/layout.tsx); these apply only inside the marketing wrapper.
 * Files are the Latin subset woff2 from the fontsource packages (SIL Open Font License 1.1; the licence texts sit beside them).
 */
const display = localFont({
  src: [{ path: "./fonts-files/barlow-condensed-latin-600-normal.woff2", weight: "600", style: "normal" }],
  variable: "--mk-font-display",
  display: "swap",
  fallback: ["Arial Narrow", "Arial", "sans-serif"],
  adjustFontFallback: "Arial",
});
const sans = localFont({
  src: [
    { path: "./fonts-files/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts-files/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--mk-font-sans",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
  adjustFontFallback: "Arial",
});
const mono = localFont({
  src: [
    { path: "./fonts-files/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts-files/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--mk-font-mono",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "Consolas", "monospace"],
  adjustFontFallback: false,
});

export const marketingFontVariables = `${display.variable} ${sans.variable} ${mono.variable}`;
