// Inputs: none (pure drawings). Output: the small inline SVG props around Tooly: spanner, hex nut, threaded stud and the document sheet.
// Drawn as technical line art in the Tolra navy and white (1.5px navy outline, white fill, no gradients or shadows) so they sit beside the
// real pose stills without imitating them. All are aria-hidden and take no pointer events.
// Must not change: they are props, not mascot artwork: no face, no limbs. Tooly himself only ever comes from the real poses (components/tooly/poses.ts).

const INK = "#0b2a5b";
const hex = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => `${i ? "L" : "M"}${(cx + r * Math.cos((Math.PI / 3) * i)).toFixed(2)} ${(cy + r * Math.sin((Math.PI / 3) * i)).toFixed(2)}`).join(" ") + "Z";

/** A ring spanner, 100 x 30, its ring centred at (15, 15) so it can be turned about the nut it grips. */
export function Spanner({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 30" width="100" height="30" aria-hidden focusable="false">
      <path d="M26 11.5 H92 a3.5 3.5 0 0 1 0 7 H26 Z" fill="#fff" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      <path d={`M15 2 a13 13 0 1 0 0.01 0 Z ${hex(15, 15, 7.2)}`} fill="#fff" fillRule="evenodd" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M32 15 H84" stroke={INK} strokeWidth="1" strokeOpacity="0.35" strokeLinecap="round" />
    </svg>
  );
}

/** A hex nut on the top of the stud, 30 x 30. */
export function HexNut({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 30 30" width="30" height="30" aria-hidden focusable="false">
      <path d={hex(15, 15, 12.5)} fill={INK} stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      <path d={hex(15, 15, 5.5)} fill="#fff" />
    </svg>
  );
}

/** A threaded stud, 12 wide, any height (stretches). */
export function Stud({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 60" width="12" height="60" preserveAspectRatio="none" aria-hidden focusable="false">
      <rect x="2" y="0" width="8" height="60" fill="#fff" stroke={INK} strokeWidth="1.5" />
      <path d="M2 8 H10 M2 16 H10 M2 24 H10 M2 32 H10 M2 40 H10 M2 48 H10 M2 56 H10" stroke={INK} strokeWidth="1" />
    </svg>
  );
}

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
