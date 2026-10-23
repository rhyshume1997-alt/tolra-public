"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The pad's own coordinate space; the stored path is in these units whatever size the pad is shown at. */
export const PAD_WIDTH = 600;
export const PAD_HEIGHT = 200;
/** A drawn signature needs at least this much ink (pad units), so a tap or a stray line isn't a signature. */
export const MIN_STROKE_LENGTH = 60;
/** The database's limit on the stored path (migration 045). */
export const MAX_PATH_LENGTH = 100000;
/** Characters a stored path may contain (the CHECK in migration 045). */
export const PATH_PATTERN = /^M[MLQZml0-9 .,-]*$/;

export type Point = { x: number; y: number };
export type Signature = { kind: "drawn" | "typed"; data: string };

const clampRound = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));

/** Strokes -> SVG path data: "M12 30L14 31L20 33M40 30L41 35". A single-point stroke becomes a dot (M x y L x y). */
export function encodePath(strokes: Point[][]): string {
  let path = "";
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    const points = stroke.map((p) => `${clampRound(p.x, PAD_WIDTH)} ${clampRound(p.y, PAD_HEIGHT)}`);
    path += `M${points[0]}`;
    for (const point of points.length === 1 ? points : points.slice(1)) path += `L${point}`;
  }
  return path;
}

/** Total ink length of the strokes, in pad units. */
export function strokeLength(strokes: Point[][]): number {
  let total = 0;
  for (const stroke of strokes) for (let i = 1; i < stroke.length; i++) total += Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y);
  return total;
}

/** The signature the strokes make, or null when there isn't enough ink or the path would be too long to store. */
export function drawnSignature(strokes: Point[][]): string | null {
  if (strokeLength(strokes) < MIN_STROKE_LENGTH) return null;
  const path = encodePath(strokes);
  return path.length <= MAX_PATH_LENGTH && PATH_PATTERN.test(path) ? path : null;
}

/**
 * A stored path, parsed into numbers and written out again as move/line commands only: what is rendered is never the stored text,
 * so nothing but digits reaches the SVG attribute. Null when the text isn't a path this pad draws (the database CHECK is wider).
 */
export function parseSignaturePath(path: string): string | null {
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(path)) return null;
  const command = /\s*([ML])\s*(\d{1,4}(?:\.\d+)?)[ ,]+(\d{1,4}(?:\.\d+)?)\s*/gy;
  let out = "";
  let at = 0;
  while (at < path.length) {
    command.lastIndex = at;
    const m = command.exec(path);
    if (!m) return null;
    out += `${m[1]}${clampRound(Number(m[2]), PAD_WIDTH)} ${clampRound(Number(m[3]), PAD_HEIGHT)}`;
    at = command.lastIndex;
  }
  return out.startsWith("M") && out.includes("L") ? out : null;
}

/** A stored drawn signature, shown as an image (an unparseable path shows as an empty box, never as markup). */
export function SignatureImage({ path, className = "h-12 w-36" }: { path: string; className?: string }) {
  const d = parseSignaturePath(path);
  return (
    <svg viewBox={`0 0 ${PAD_WIDTH} ${PAD_HEIGHT}`} className={className} role="img" aria-label={d ? "Drawn signature" : "Signature could not be shown"}>
      {d ? <path d={d} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

/**
 * Draw with a finger, stylus or mouse (pointer events; no dependency), or type instead. `large` gives the workshop's 48px touch
 * targets (44px otherwise).
 */
export function SignaturePad({ onChange, typedDefault = "", large = false, disabled = false }: { onChange: (signature: Signature | null) => void; typedDefault?: string; large?: boolean; disabled?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [typed, setTyped] = useState(typedDefault);
  const [hint, setHint] = useState<string | null>(null);
  const target = large ? "min-h-12 min-w-12" : "min-h-11 min-w-11";

  function point(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * PAD_WIDTH, y: ((event.clientY - rect.top) / rect.height) * PAD_HEIGHT };
  }

  function line(from: Point, to: Point) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  function report() {
    const path = drawnSignature(strokes.current);
    setHint(strokes.current.length && !path ? "Keep going: that's too short to be a signature." : null);
    onChange(path ? { kind: "drawn", data: path } : null);
  }

  function down(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawing.current = true;
    const p = point(event);
    strokes.current.push([p]);
    line(p, p);
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const stroke = strokes.current[strokes.current.length - 1];
    const last = stroke[stroke.length - 1];
    const p = point(event);
    if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
    stroke.push(p);
    line(last, p);
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    report();
  }

  function clear() {
    strokes.current = [];
    canvasRef.current?.getContext("2d")?.clearRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
    setHint(null);
    onChange(null);
  }

  function switchTo(next: "drawn" | "typed") {
    setMode(next);
    setHint(null);
    if (next === "typed") onChange(typed.trim() ? { kind: "typed", data: typed.trim() } : null);
    else report();
  }

  return (
    <div className="grid gap-2" data-signature-mode={mode}>
      {mode === "drawn" ? (
        <>
          <canvas
            ref={canvasRef}
            width={PAD_WIDTH}
            height={PAD_HEIGHT}
            aria-label="Signature pad: sign with your finger, a stylus or the mouse"
            className="aspect-[3/1] w-full max-w-xl cursor-crosshair rounded-md border border-dashed border-slate-500 bg-white"
            style={{ touchAction: "none" }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={up}
          />
          {hint ? <p className="text-xs text-amber-800">{hint}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className={target} disabled={disabled} onClick={clear}>Clear</Button>
            <Button type="button" variant="ghost" className={target} disabled={disabled} onClick={() => switchTo("typed")}>Type instead</Button>
          </div>
        </>
      ) : (
        <>
          <Input
            aria-label="Typed signature"
            value={typed}
            maxLength={200}
            disabled={disabled}
            className={`${large ? "h-12" : "h-11"} font-serif text-lg italic`}
            onChange={(event) => {
              setTyped(event.target.value);
              onChange(event.target.value.trim() ? { kind: "typed", data: event.target.value.trim() } : null);
            }}
          />
          <p className="text-xs text-slate-600">Typing your name here is your e-signature.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" className={target} disabled={disabled} onClick={() => switchTo("drawn")}>Draw instead</Button>
          </div>
        </>
      )}
    </div>
  );
}
