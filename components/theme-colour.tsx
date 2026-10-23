"use client";

import { useLayoutEffect } from "react";

import { PRODUCT_BRANDING } from "@/lib/branding";
import { shellColours } from "@/lib/brand-pending";
import { useCompanyProfile } from "@/lib/company";

const VARS = ["--brand", "--brand-accent", "--brand-ink"] as const;

/**
 * Applies the signed-in company's brand colours to the app (buttons, sidebar, links, focus rings via the --brand
 * tokens in globals.css) and to the browser / installed-app title bar. A plain neutral until the company is known (lib/brand-pending),
 * then the company's, or the product's when it has set none. Set before the first paint (layout effect), so the product's navy is
 * never shown first.
 */
export function ThemeColour() {
  const { profile, loading } = useCompanyProfile();
  const { primary, accent, ink } = shellColours(profile, loading);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--brand", primary);
    root.setProperty("--brand-accent", accent);
    // White or near-black text, whichever reads better on the brand colour.
    root.setProperty("--brand-ink", ink);
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    metas.forEach((meta) => meta.setAttribute("content", primary));
    return () => {
      VARS.forEach((name) => root.removeProperty(name));
      metas.forEach((meta) => meta.setAttribute("content", PRODUCT_BRANDING.primary));
    };
  }, [primary, accent, ink]);
  return null;
}
