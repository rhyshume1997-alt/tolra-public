"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import { BracketT } from "@/components/marketing/bracket-t";

/** The plain mark: shown until the glass loads, and in its place if it never does. */
function StillMark() {
  return <BracketT size={64} bracket="#0b2a5b" ink="#0b2a5b" title="Tolra" />;
}

// The WebGL reveal is code-split and client only, so it never weighs on the first paint.
const GlassRevealTolra = dynamic(() => import("@/components/ui/liquid-glass-logo-reveal").then((m) => m.GlassRevealTolra), {
  ssr: false,
  loading: () => <StillMark />,
});

/** The closing panel's mark: the glass reveal, loaded only once the panel is near the screen, and played once when it is on it. */
export function GlassMark() {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="mk-glass">
      {near ? <GlassRevealTolra className="absolute inset-0 h-full w-full" /> : <StillMark />}
    </div>
  );
}
