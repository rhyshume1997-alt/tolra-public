// Inputs: none (pure drawing). Output: the one inline SVG prop in the menu: the document sheet that travels down the stages.
// (Tooly's spanner and bolt are not drawn here: they are part of his own on-model frames.) Drawn as technical line art in the Tolra navy and white (1.5px navy outline, white fill, no gradients or shadows) so they sit beside the
// real pose stills without imitating them. All are aria-hidden and take no pointer events.
// Must not change: they are props, not mascot artwork: no face, no limbs. Tooly himself only ever comes from the real poses (components/tooly/poses.ts).

const INK = "#0b2a5b";

/** The document that travels down the stages: a sheet with a folded corner, 22 x 28. */
export function DocSheet({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 22 28" width="22" height="28" aria-hidden focusable="false">
      <path d="M1.5 1.5 H14 L20.5 8 V26.5 H1.5 Z" fill="#fff" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M14 1.5 V8 H20.5" fill="none" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5 13 H17 M5 17 H17 M5 21 H12" stroke={INK} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
