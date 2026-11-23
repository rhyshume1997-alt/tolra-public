"use client";

import { useEffect, useState } from "react";

import { ToolyMark } from "@/components/marketing/tooly-mark";
import { LAST_ORG_KEY } from "@/lib/branding";

// Inputs: `neutral`, decided on the server by app/login/layout.tsx (no ?org-less brand hint: no company subdomain and no brand cookie).
// Output: a decorative Tooly (waves once, idles, blinks, sleeps when the page is left alone) fixed at the foot of the sign-in page's left
// panel, on wide, tall screens only (marketing.css .mk-login-tooly), where it clears the panel's text.
// Must not change: purely presentational. It is out of the page's flow (fixed), so the form never shifts; it takes no focus and no pointer
// events and is hidden from assistive tech; it carries no text, so it cannot affect contrast. It appears only after the page has mounted and
// only on the neutral Tolra page (no ?org in the address, nothing remembered on this device), so a company's own brand is never joined by
// Tolra's mascot and nothing is added to the first paint. It reads no auth state and touches nothing in login-form.tsx.

export function LoginTooly({ neutral }: { neutral: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!neutral) return;
    let remembered = false;
    try { remembered = Boolean(window.localStorage.getItem(LAST_ORG_KEY)); } catch { /* storage blocked: treat as nothing remembered */ }
    const asked = Boolean(new URLSearchParams(window.location.search).get("org")?.trim());
    setShow(!remembered && !asked);
  }, [neutral]);
  if (!show) return null;
  return (
    <div aria-hidden="true" className="mk-login-tooly pointer-events-none fixed bottom-16 left-[calc(53.49vw-10rem)] z-10">
      <ToolyMark size={144} />
    </div>
  );
}
