/**
 * The Tolra Machine in 3D: the pure geometry and choices behind components/marketing/gear-workflow-3d.tsx, kept here so they can be
 * tested without a browser.
 *
 * Inputs: the seven stages, their tooth counts and the chain layout (meshing phases) from lib/marketing/gear-workflow.ts.
 * Outputs: the ring of gears around the display (world units, y up, plate top at z = 0), involute tooth outlines, the etched label
 * boxes, camera stops for the overview, each stage and the final reveal, and the words the 3D version adds. (The ?gears= switch
 * and the render tier live in lib/marketing/gear-workflow.ts, so the home page can read them without this module.)
 * Must not change: the stage order, tooth counts and meshing rules (shared with the 2D drawing and its tests).
 */
import { GEAR_STAGES, STAGE_COUNT, layoutChain, type Gear, type RenderTier } from "./gear-workflow";

export type { RenderTier } from "./gear-workflow";

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Tooth outline                                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const PRESSURE = (20 * Math.PI) / 180;
const inv = (a: number) => Math.tan(a) - a;

/**
 * A true involute spur gear outline (20 degree pressure angle, addendum = module, dedendum = 1.25 x module), tooth 0 centred on +x,
 * in the 2D drawing's convention (angles measured towards +y). Each tooth is thinned by `backlash` (module units, at the pitch
 * circle) so meshing teeth never touch. Below the base circle the flank runs radially down to the root circle.
 */
export function toothOutline(teeth: number, module = 1, flankSamples = 5, backlash = 0.06): Array<[number, number]> {
  const r = (module * teeth) / 2;
  const ra = r + module;
  const rr = r - 1.25 * module;
  const rb = r * Math.cos(PRESSURE);
  const pitch = (2 * Math.PI) / teeth;
  const halfAtPitch = Math.PI / (2 * teeth) - (backlash * module) / 2 / r;
  const half = (rho: number) => halfAtPitch + inv(PRESSURE) - inv(Math.acos(rb / Math.max(rho, rb)));
  const radii = [rr, ...Array.from({ length: flankSamples + 1 }, (_, j) => Math.max(rb, rr) + ((ra - Math.max(rb, rr)) * j) / flankSamples)];
  const at = (rho: number, a: number): [number, number] => [rho * Math.cos(a), rho * Math.sin(a)];
  const points: Array<[number, number]> = [];
  for (let k = 0; k < teeth; k += 1) {
    const c = k * pitch;
    for (const rho of radii) points.push(at(rho, c - half(rho)));
    const tip = half(ra);
    points.push(at(ra, c - tip / 3), at(ra, c + tip / 3));
    for (const rho of [...radii].reverse()) points.push(at(rho, c + half(rho)));
    const from = c + half(rr);
    const to = c + pitch - half(rr);
    for (let j = 1; j <= 3; j += 1) points.push(at(rr, from + ((to - from) * j) / 4));
  }
  return points;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* The machine: a ring of gears around the display                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** The chain turns up, across and down, so the seven gears arch over the display set into the plate. */
export const RING_ANGLES = [-65, -30, 5, -5, 30, 65] as const;

export type Box = { x0: number; y0: number; x1: number; y1: number };

export type SceneGear = Pick<Gear, "index" | "teeth" | "r" | "ra" | "rr" | "phase" | "spin" | "toNext"> & {
  /** Centre, world units (y up). */
  x: number;
  y: number;
  /** Face width (thickness) of the toothed rim; bigger gears are thicker. */
  face: number;
  hub: number;
  bore: number;
  holes: { count: number; at: number; size: number };
};

export type SceneLabel = { index: number; op: string; lines: string[]; x: number; y: number; w: number; h: number };

export type MachineScene = {
  gears: SceneGear[];
  /** The display window (the stage image), its bezel width and height above the plate. */
  display: { x: number; y: number; w: number; h: number; bezel: number; height: number };
  labels: SceneLabel[];
  /** Everything that has to be in the overview: gears, labels and the display with its bezel. */
  bounds: Box;
  plate: { w: number; h: number };
  /** Height of the gear underside above the plate (bronze bushing and spacer). */
  lift: number;
};

/** Label text size in world units: the stage name, and the OP number above it. */
export const LABEL_TEXT = { name: 1.7, op: 1.05, gap: 0.45, perChar: 0.9 } as const;
/** Which side of its gear each stage's label sits on, away from the display. */
const LABEL_SIDE = ["below", "left", "above", "above", "above", "right", "below"] as const;
const LABEL_GAP = 2.2;
/** Labels above a gear sit further off: seen from the front at an angle, the gear's height would otherwise hide them. */
const LABEL_GAP_ABOVE = 5.6;
/** The display shows images in 16:10. */
export const DISPLAY_ASPECT = 1.6;

function wrapName(label: string, side: (typeof LABEL_SIDE)[number]): string[] {
  const upper = label.toUpperCase();
  if (side !== "left" && side !== "right") return [upper];
  if (upper.length <= 14) return [upper];
  const words = upper.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > 14) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function buildScene(): MachineScene {
  const chain = layoutChain("wide", 1, RING_ANGLES, 0);
  const g0 = chain.gears[0];
  const g6 = chain.gears[STAGE_COUNT - 1];
  // Display: centred between the first and last gear, sitting low inside the arch (chain units, y down).
  const dw = 46;
  const dh = dw / DISPLAY_ASPECT;
  const bezel = 2.4;
  const dcx = (g0.cx + g6.cx) / 2;
  const dcy = g0.cy + 9.2;

  // Labels, in chain units (y down), on the side of each gear away from the display.
  const rawLabels = chain.gears.map((g, i) => {
    const side = LABEL_SIDE[i];
    const lines = wrapName(GEAR_STAGES[i].label, side);
    const w = Math.max(6, ...lines.map((l) => l.length * LABEL_TEXT.perChar));
    const h = LABEL_TEXT.op + LABEL_TEXT.gap + lines.length * LABEL_TEXT.name * 1.1;
    const off = g.ra + (side === "above" ? LABEL_GAP_ABOVE : LABEL_GAP);
    const x = side === "left" ? g.cx - off - w / 2 : side === "right" ? g.cx + off + w / 2 : g.cx;
    const y = side === "above" ? g.cy - off - h / 2 : side === "below" ? g.cy + off + h / 2 : g.cy;
    return { index: i, op: `OP ${GEAR_STAGES[i].op}`, lines, x, y, w, h };
  });

  const boxes: Box[] = [
    ...chain.gears.map((g) => ({ x0: g.cx - g.ra, y0: g.cy - g.ra, x1: g.cx + g.ra, y1: g.cy + g.ra })),
    ...rawLabels.map((l) => ({ x0: l.x - l.w / 2, y0: l.y - l.h / 2, x1: l.x + l.w / 2, y1: l.y + l.h / 2 })),
    { x0: dcx - dw / 2 - bezel, y0: dcy - dh / 2 - bezel, x1: dcx + dw / 2 + bezel, y1: dcy + dh / 2 + bezel },
  ];
  const minX = Math.min(...boxes.map((b) => b.x0));
  const maxX = Math.max(...boxes.map((b) => b.x1));
  const minY = Math.min(...boxes.map((b) => b.y0));
  const maxY = Math.max(...boxes.map((b) => b.y1));
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  // Chain units (y down) to world (centred, y up).
  const wx = (x: number) => round3(x - mx);
  const wy = (y: number) => round3(-(y - my));

  const gears: SceneGear[] = chain.gears.map((g) => ({
    index: g.index,
    teeth: g.teeth,
    r: g.r,
    ra: g.ra,
    rr: g.rr,
    phase: g.phase,
    spin: g.spin,
    toNext: g.toNext,
    x: wx(g.cx),
    y: wy(g.cy),
    face: round3(Math.min(4.4, Math.max(2.6, 0.3 * g.ra + 0.6))),
    hub: round3(Math.max(2.4, g.r * 0.32)),
    bore: round3(Math.max(0.9, g.r * 0.1)),
    holes: g.holes,
  }));
  const halfW = (maxX - minX) / 2;
  const halfH = (maxY - minY) / 2;
  return {
    gears,
    display: { x: wx(dcx), y: wy(dcy), w: dw, h: round3(dh), bezel, height: 2.0 },
    labels: rawLabels.map((l) => ({ ...l, x: wx(l.x), y: wy(l.y), w: round3(l.w), h: round3(l.h) })),
    bounds: { x0: -round3(halfW), y0: -round3(halfH), x1: round3(halfW), y1: round3(halfH) },
    // The plate runs well past the frame of the overview and stage views; only the final reveal pulls back far enough to see its edge.
    plate: { w: round3(2 * halfW + 90), h: round3(2 * halfH + 50) },
    lift: 0.9,
  };
}

/** Built once, on first import; marked pure so pages that only need the switch and the tier do not carry the geometry. */
export const MACHINE: MachineScene = /* #__PURE__ */ buildScene();

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Camera                                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export type Vec3 = [number, number, number];
export type CameraStop = { position: Vec3; target: Vec3 };

/** Vertical field of view, degrees: a long lens, as in product photography, so the machine is not distorted. */
export const FOV = 24;

const rad = (d: number) => (d * Math.PI) / 180;

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Where points land on screen for a camera at `position` aimed at `target` (z up), as normalised device coordinates (-1 to 1).
 * The same projection three.js uses for a perspective camera, written out so this module stays free of the 3D library.
 */
export function projectPoints(stop: CameraStop, aspect: number, points: readonly V[]): Array<[number, number]> {
  const f = norm(sub(stop.target, stop.position));
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  const t = Math.tan(rad(FOV) / 2);
  return points.map((p) => {
    const d = sub(p, stop.position);
    const z = dot(d, f);
    return [dot(d, r) / (z * t * aspect), dot(d, u) / (z * t)];
  });
}

/**
 * A camera that frames `box` (world units, on the plate, up to `height` above it) at the given aspect: tilted `tilt` degrees from
 * straight down towards the viewer and swung `yaw` degrees to the side, then panned and dollied until the box sits centred with
 * `margin` to spare (1.1 = the box fills 1 / 1.1 of the frame's tighter side).
 */
export function frameBox(box: Box, aspect: number, tilt: number, yaw: number, margin: number, height = 6): CameraStop {
  const corners: V[] = [];
  for (const x of [box.x0, box.x1]) for (const y of [box.y0, box.y1]) for (const z of [0, height]) corners.push([x, y, z]);
  const t = rad(tilt);
  const w = rad(yaw);
  const dir: V = [Math.sin(t) * Math.sin(w), -Math.sin(t) * Math.cos(w), Math.cos(t)];
  let target: V = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, height / 2];
  let dist = Math.max(box.x1 - box.x0, box.y1 - box.y0) * 2;
  const place = (): CameraStop => ({ position: [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist], target });
  for (let k = 0; k < 24; k += 1) {
    const stop = place();
    const pts = projectPoints(stop, aspect, corners);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const fill = Math.max((Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2);
    // Pan so the box is centred, along the camera's own right and up axes, then dolly so it fills the frame less the margin.
    const f = norm(sub(stop.target, stop.position));
    const r = norm(cross(f, [0, 0, 1]));
    const u = cross(r, f);
    const span = dist * Math.tan(rad(FOV) / 2);
    target = [
      target[0] + r[0] * cx * span * aspect + u[0] * cy * span,
      target[1] + r[1] * cx * span * aspect + u[1] * cy * span,
      target[2] + r[2] * cx * span * aspect + u[2] * cy * span,
    ];
    dist *= fill * margin;
  }
  const done = place();
  return { position: done.position.map(round3) as Vec3, target: done.target.map(round3) as Vec3 };
}

const gearBox = (i: number): Box => {
  const g = MACHINE.gears[i];
  const l = MACHINE.labels[i];
  return {
    x0: Math.min(g.x - g.ra, l.x - l.w / 2), y0: Math.min(g.y - g.ra, l.y - l.h / 2),
    x1: Math.max(g.x + g.ra, l.x + l.w / 2), y1: Math.max(g.y + g.ra, l.y + l.h / 2),
  };
};

export const displayBox = (): Box => {
  const d = MACHINE.display;
  return { x0: d.x - d.w / 2 - d.bezel, y0: d.y - d.h / 2 - d.bezel, x1: d.x + d.w / 2 + d.bezel, y1: d.y + d.h / 2 + d.bezel };
};

const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/** The whole machine, nearly square on. */
export function overviewStop(aspect: number): CameraStop {
  return frameBox(MACHINE.bounds, aspect, 18, 0, 1.06);
}

/** Leaning in towards the selected gear, with the display still in view, so the gear and what it does are seen together. */
export function stageStop(index: number, aspect: number, tier: RenderTier = "full"): CameraStop {
  const g = MACHINE.gears[index];
  const half = (MACHINE.bounds.x1 - MACHINE.bounds.x0) / 2;
  const yaw = tier === "full" ? Math.max(-1, Math.min(1, g.x / half)) * 9 : 0;
  return frameBox(union(gearBox(index), displayBox()), aspect, tier === "full" ? 30 : 24, yaw, 1.08);
}

/**
 * The final reveal: the camera pulls back and round to show the whole mechanism from a lower, more dramatic angle, with the
 * machine in the upper part of the frame so the closing message beneath it covers nothing.
 */
export function revealStop(aspect: number): CameraStop {
  const b = MACHINE.bounds;
  const room = (b.y1 - b.y0) * (aspect > 1.5 ? 0.42 : 0.3);
  return frameBox({ ...b, y0: b.y0 - room }, aspect, 38, -9, 1.04);
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Words                                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Everything the 3D version says, beyond the stage copy it shares with the 2D drawing. */
export const SCENE_COPY = {
  head: "The Tolra machine",
  note: "3D illustration, example values",
  hintPointer: "Click a gear to turn the machine",
  hintTouch: "Tap a gear to turn the machine",
  revealKicker: "Op 10 to Op 70",
  revealTitle: "Enquiry to invoice, on one job",
  restart: "Start again",
} as const;
