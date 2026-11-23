/*
 * BOUNDARY (module 7, shared UI, NEW v4). Inputs: none. Output: loads the IBM Plex Sans latin files (400, 500, 600) and IBM Plex Mono latin 400 from the @fontsource packages that are already dependencies, so the shared set carries its own font.
 * They are bundled by the build and served from the same origin (CSP font-src 'self' data:). @fontsource CSS only declares @font-face (a family name, nothing else); it sets no global rule. Nothing applies the family except the .tokens class in
 * premium.module.css, so a page that does not use the shared set keeps its own font, and the browser downloads a file only when text in that family is drawn.
 * Must not change: no other font, no weight above 600 (the UI scale uses 400, 500, 600), no dependency added, no edit outside this folder.
 */
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";

export const UI_FONT_FAMILY = "IBM Plex Sans";
export const UI_FONT_WEIGHTS = [400, 500, 600] as const;
