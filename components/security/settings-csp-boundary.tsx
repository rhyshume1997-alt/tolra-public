"use client";

/**
 * Settings has its own, wider Content-Security-Policy (next.config.mjs settingsCsp: data: connect and blob: frame for the Document designs preview).
 * Next keeps the first document's policy across client-side navigation, so a page reached from Settings would inherit it.
 * Input: the current path. Output: nothing rendered; when the path changes from /settings to anything else it reloads that address as a normal
 * document load, so the destination gets the policy header of its own route. The same reload applies when a client-side navigation arrives AT Settings
 * (browser Back or Forward, which no link controls), so Settings never runs under another page's policy. Links into Settings are plain anchors
 * (lib/full-document-load) and do not reach this.
 * Must not change: it renders nothing, reads and writes no data and never alters a policy. The global CSP stays as it is.
 */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { markBoundaryReload } from "@/lib/full-document-load";

export function SettingsCspBoundary() {
  const pathname = usePathname();
  const previous = useRef(pathname);
  useEffect(() => {
    if ((previous.current === "/settings") !== (pathname === "/settings")) { markBoundaryReload(); window.location.replace(window.location.href); }
    previous.current = pathname;
  }, [pathname]);
  return null;
}
