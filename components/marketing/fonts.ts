import localFont from "next/font/local";

/** The same marketing faces, bundled from installed WOFF2 assets: no Google request during builds or in the browser. */
const display = localFont({
  src: "../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2",
  weight: "600", variable: "--mk-font-display", display: "swap",
});
const sans = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2", weight: "400" },
    { path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2", weight: "600" },
  ],
  variable: "--mk-font-sans", display: "swap",
});
const mono = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", weight: "400" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", weight: "500" },
  ],
  variable: "--mk-font-mono", display: "swap",
});

export const marketingFontVariables = `${display.variable} ${sans.variable} ${mono.variable}`;
