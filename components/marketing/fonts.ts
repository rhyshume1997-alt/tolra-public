import { Barlow_Condensed, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

/**
 * The public pages' faces, downloaded at build time and served from this site (next/font; the CSP allows fonts from 'self' only).
 * Headings: Barlow Condensed (DIN-like drawing lettering). Body: IBM Plex Sans. Job and part numbers, revs and dates: IBM Plex Mono.
 * The app's own pages keep their fonts (app/layout.tsx); these apply only inside the marketing wrapper.
 */
const display = Barlow_Condensed({ subsets: ["latin"], weight: ["600"], variable: "--mk-font-display", display: "swap" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "600"], variable: "--mk-font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--mk-font-mono", display: "swap" });

export const marketingFontVariables = `${display.variable} ${sans.variable} ${mono.variable}`;
