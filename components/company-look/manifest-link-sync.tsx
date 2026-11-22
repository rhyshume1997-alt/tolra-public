"use client";

import { useEffect } from "react";

import { iconHrefFor, manifestHref } from "@/lib/company-look/installed-app";

/**
 * BOUNDARY (module 13, Company look). Sign-in page only. Input: the company slug the page is showing (or null for the neutral page).
 * Output: points the page's manifest link at that same company, so installing from a sign-in page installs the company the page shows,
 * not whichever company this device remembers. A hook (renders nothing); does nothing unless `enabled` (the server flag, passed down by the page); touches only the manifest, icon and apple-touch-icon links. The server decides what the manifest contains.
 */
export function useManifestLinkSync(enabled: boolean, slug: string | null) {
  useEffect(() => {
    if (!enabled) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) link.setAttribute("href", manifestHref(slug));
    // The favicon and home-screen icon links, likewise (only our own icon route).
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((icon) => {
      const href = icon.getAttribute("href");
      if (href) icon.setAttribute("href", iconHrefFor(href, slug));
    });
  }, [enabled, slug]);
}
