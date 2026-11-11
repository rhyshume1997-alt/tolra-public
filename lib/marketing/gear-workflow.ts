/**
 * "The Tolra Machine": data and geometry for the gear workflow on the public home page (components/marketing/gear-workflow.tsx).
 *
 * Inputs: FLOW_STEPS and PAIN_CARDS from lib/marketing.ts (the checked copy; this module never rewrites a caption or a record value).
 * Outputs: GEAR_STAGES (seven stages, one per gear, each with its image in public/marketing/workflow/), two gear layouts (wide and compact) with tooth paths, centres and meshing phases,
 * pure helpers for selection (stepTo, clampStage) and rotation (gearAngle), and the version switch (?gears=, parseGearsParam) with the
 * render tier for the 3D version (chooseTier). The switch defaults to the 2D drawing.
 * Must not change: the stage captions and example records come from FLOW_STEPS; the extra detail lines below describe only what the
 * app's code does today (migrations 081-083, the dashboard tiles, the FEATURES copy). No prices, numbers of hours, results or
 * integrations. Plain data and maths only: no React, no browser APIs, so the unit tests can read it.
 */
import { FLOW_STEPS, PAIN_CARDS } from "@/lib/marketing";

type FlowStep = (typeof FLOW_STEPS)[number];
export type StageId = FlowStep["id"];

export type GearStage = {
  id: StageId;
  op: string;
  label: string;
  stamp: string;
  caption: string;
  record: ReadonlyArray<readonly [string, string]>;
  /** The problem from "Sound familiar?" that this stage answers, if any. */
  solves: string | null;
  /** What else Tolra does at this stage. Each line is something the app does today. */
  details: readonly string[];
  /** Tooth count of this stage's gear. */
  teeth: number;
  /** What the stage looks like in Tolra: a document Tolra produces, or a screen. Example data only. */
  shot: StageShot;
};

export type StageShot = {
  src: string;
  width: number;
  height: number;
  alt: string;
  /** "document": a page Tolra prints or sends; "screen": a screen in the app. */
  kind: "document" | "screen";
  /** Where it comes from in Tolra, shown above the image. */
  source: string;
};

/**
 * One image per stage, in public/marketing/workflow/. Documents are Tolra's own PDF templates and the printed worksheet; screens are
 * the app's own Machine timeline and two crops of the site's existing dashboard and Job Board screenshots. Every name, number and
 * amount in them is example data (Example Engineering Ltd, Example Plant Co, J-0001); none names a real company or person.
 */
const SHOTS: Record<StageId, StageShot> = {
  enquiry: {
    src: "/marketing/workflow/enquiry.webp", width: 1262, height: 438, kind: "screen", source: "Dashboard, Today",
    alt: "Tolra dashboard, Today view, with example data: tiles for quotes with no reply, enquiries not quoted, jobs running late, work waiting to be checked and money late.",
  },
  quote: {
    src: "/marketing/workflow/quote.webp", width: 1100, height: 1338, kind: "document", source: "Quote, as sent",
    alt: "Quote QUO-0001 from Example Engineering Ltd to Example Plant Co, with example values: 20 mounting brackets to drawing BR-114 rev B and a material certificate pack, with VAT, terms and the customer message.",
  },
  po: {
    src: "/marketing/workflow/sales-order.webp", width: 1100, height: 1338, kind: "document", source: "Sales order",
    alt: "Sales order for the customer's order 4471 against quote QUO-0001, from Example Engineering Ltd to Example Plant Co, with example values.",
  },
  worksheet: {
    src: "/marketing/workflow/worksheet.webp", width: 1100, height: 1350, kind: "document", source: "Printed job worksheet",
    alt: "Job worksheet J-0001 for Example Plant Co, with example values: customer PO 4471, quote QUO-0001, material cert and heat/cast numbers, drawing BR-114 rev B, 20 off in S355 plate, Laser 1 then the press brake, the part checklist and sign-off.",
  },
  schedule: {
    src: "/marketing/workflow/schedule.webp", width: 1400, height: 495, kind: "screen", source: "Machine timeline",
    alt: "Tolra machine timeline over two weeks, with example jobs: J-0001 and J-0005 on Laser 1, J-0001 on the press brake, J-0003 on Mill 1, J-0006 on Lathe 1 and J-0004 in the welding bay.",
  },
  signoff: {
    src: "/marketing/workflow/inspection.webp", width: 1262, height: 318, kind: "screen", source: "Job Board",
    alt: "Tolra Job Board with example data: tiles for open jobs, not started, running, waiting for inspection, complete and average job time.",
  },
  invoice: {
    src: "/marketing/workflow/invoice.webp", width: 1100, height: 1338, kind: "document", source: "Invoice, as issued",
    alt: "Invoice INV-0001 from Example Engineering Ltd to Example Plant Co, with example values: quote QUO-0001, customer PO 4471, the same two lines, VAT and the balance due.",
  },
};

/** Display names where the gear needs a fuller name than the traveller's short label. */
const LABELS: Partial<Record<StageId, string>> = { po: "Customer PO", signoff: "Sign-off and inspection" };

const SOLVES: Partial<Record<StageId, string>> = {
  enquiry: PAIN_CARDS[0].title,
  schedule: PAIN_CARDS[1].title,
  invoice: PAIN_CARDS[2].title,
  worksheet: PAIN_CARDS[3].title,
};

const DETAILS: Record<StageId, readonly string[]> = {
  enquiry: [
    "Enquiries not yet quoted are counted on the dashboard.",
    "The optional AI helper can draft a quote from a pasted enquiry email, for you to check. It stays off until your admin switches it on.",
  ],
  quote: [
    "Your logo, its own running number, VAT and your terms on every quote.",
    "Quotes with no reply are counted on the dashboard, ready to chase.",
  ],
  po: [
    "The customer's purchase order is kept against the quote it answers.",
    "The sales order carries the quote forward, so nothing is typed twice.",
  ],
  worksheet: [
    "When a job needs a drawing revision, it can't be completed without one.",
    "On traceable jobs, a pass needs the material cert number and heat/cast number.",
  ],
  schedule: [
    "One lane per machine, with the jobs booked on it.",
    "See which machine is free, and when, without a whiteboard.",
  ],
  signoff: [
    "Only authorised inspectors record an inspection pass.",
    "A delivery note can't be made until the job passes, unless an admin releases it early with a reason.",
    "Failed work is recorded as rework, scrap and remake, or a concession, which only an admin can authorise.",
  ],
  invoice: [
    "The job's material certificates are kept with its delivery note.",
    "You check every draft before it is issued.",
  ],
};

/** Tooth counts, chosen so neighbouring gears differ in size and every pair meshes on the same module. */
const TEETH: Record<StageId, number> = { enquiry: 18, quote: 12, po: 22, worksheet: 14, schedule: 24, signoff: 12, invoice: 20 };

export const GEAR_STAGES: readonly GearStage[] = FLOW_STEPS.map((step) => ({
  id: step.id,
  op: step.op,
  label: LABELS[step.id] ?? step.label,
  stamp: step.stamp,
  caption: step.caption,
  record: step.record,
  solves: SOLVES[step.id] ?? null,
  details: DETAILS[step.id],
  teeth: TEETH[step.id],
  shot: SHOTS[step.id],
}));

export const GEAR_COPY = {
  hint: "Select a gear, or use the arrows, to follow one job through Tolra.",
  label: "The Tolra machine: seven connected stages of one job",
  illustration: "Illustration",
  example: "example values",
  fixes: "Fixes",
  record: "On the job",
  previous: "Previous stage",
  next: "Next stage",
  selector: "Stages of one job",
  shotNote: "example data",
  fullSize: "View full size",
  close: "Close",
  hideViewer: "Hide this view",
} as const;

export const STAGE_COUNT = GEAR_STAGES.length;

/** The stage index after moving by `delta`, kept within the first and last stage (a job's process has a start and an end). */
export function stepTo(current: number, delta: number): number {
  return clampStage(current + delta);
}

export function clampStage(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(STAGE_COUNT - 1, Math.max(0, Math.round(index)));
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Geometry                                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export type Gear = {
  index: number;
  teeth: number;
  cx: number;
  cy: number;
  /** Pitch radius (where gears mesh), tip (addendum) radius and root radius. */
  r: number;
  ra: number;
  rr: number;
  /** Angle (degrees) of tooth 0 when the train is at rest; set so each pair meshes tooth into gap. */
  phase: number;
  /** +1 or -1: the direction this gear turns when the first gear turns clockwise. */
  spin: 1 | -1;
  /** Angle (degrees) of the line from this gear's centre to the next gear's centre; null for the last gear. */
  toNext: number | null;
  /** Lightening holes in the web: count, radius of the hole circle, hole radius. */
  holes: { count: number; at: number; size: number };
  hub: number;
  bore: number;
  /** The tooth outline, centred on 0,0, tooth 0 pointing along +x. */
  path: string;
};

export type GearLayout = { variant: "wide" | "compact"; module: number; width: number; height: number; viewBox: string; gears: Gear[] };

const round = (n: number) => Math.round(n * 100) / 100;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * A spur gear outline: involute-like flanks (the tooth half-angle narrows from root to tip along a smooth curve), a flat tip land
 * and a root arc between teeth. Standard proportions: addendum = module, dedendum = 1.25 x module.
 */
export function gearPath(teeth: number, module: number): string {
  const r = (module * teeth) / 2;
  const ra = r + module;
  const rr = r - 1.25 * module;
  const pitch = (2 * Math.PI) / teeth;
  // Half-angle of the tooth at root, pitch and tip, as fractions of the pitch angle; quadratic through the three.
  const hRoot = 0.3 * pitch;
  const hPitch = 0.25 * pitch;
  const hTip = 0.15 * pitch;
  const half = (rho: number) => {
    const u = (rho - rr) / (ra - rr);
    const p = (r - rr) / (ra - rr);
    // Lagrange through (0,hRoot), (p,hPitch), (1,hTip)
    return (
      (hRoot * (u - p) * (u - 1)) / ((0 - p) * (0 - 1)) +
      (hPitch * (u - 0) * (u - 1)) / ((p - 0) * (p - 1)) +
      (hTip * (u - 0) * (u - p)) / ((1 - 0) * (1 - p))
    );
  };
  const pt = (rho: number, a: number) => `${round(rho * Math.cos(a))},${round(rho * Math.sin(a))}`;
  const samples = 6;
  let d = "";
  for (let k = 0; k < teeth; k += 1) {
    const c = k * pitch;
    const left: string[] = [];
    const right: string[] = [];
    for (let j = 0; j <= samples; j += 1) {
      const rho = rr + ((ra - rr) * j) / samples;
      left.push(pt(rho, c - half(rho)));
      right.unshift(pt(rho, c + half(rho)));
    }
    d += `${k === 0 ? "M" : "L"}${left[0]} L${left.slice(1).join(" L")} A${round(ra)},${round(ra)} 0 0 1 ${right[0]} L${right.slice(1).join(" L")} `;
    d += `A${round(rr)},${round(rr)} 0 0 1 ${pt(rr, c + pitch - hRoot)} `;
  }
  return `${d}Z`;
}

/**
 * Lays the gears out as a chain: each gear meshes with the next at the sum of their pitch radii, along the given line angles.
 * Phases are set so that, at rest and at every angle of the train, a tooth of one gear sits in a gap of the next.
 */
export function layoutChain(variant: GearLayout["variant"], module: number, angles: readonly number[], pad: number, labelSpace = 0): GearLayout {
  const teeth = GEAR_STAGES.map((s) => s.teeth);
  const centres: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  for (let i = 0; i < teeth.length - 1; i += 1) {
    const dist = (module * (teeth[i] + teeth[i + 1])) / 2;
    const a = (angles[i] * Math.PI) / 180;
    centres.push({ x: centres[i].x + dist * Math.cos(a), y: centres[i].y + dist * Math.sin(a) });
  }
  const phases: number[] = [0];
  for (let i = 0; i < teeth.length - 1; i += 1) {
    const pi = 360 / teeth[i];
    const pn = 360 / teeth[i + 1];
    const alpha = angles[i];
    const t = mod(alpha - phases[i], pi);
    // Turning gear i forward by t would bring a tooth onto the line and turn gear i+1 back by t x (Ni / Ni+1), so gear i+1's gap
    // must sit that far past the opposite line now.
    phases.push(mod(alpha + 180 - 0.5 * pn + (t * teeth[i]) / teeth[i + 1], pn));
  }
  const ras = teeth.map((n) => (module * n) / 2 + module);
  const minX = Math.min(...centres.map((c, i) => c.x - ras[i])) - pad;
  const maxX = Math.max(...centres.map((c, i) => c.x + ras[i])) + pad;
  // Room above and below for the stage labels, so they sit inside the drawing rather than spilling over its edge.
  const minY = Math.min(...centres.map((c, i) => c.y - ras[i])) - pad - labelSpace;
  const maxY = Math.max(...centres.map((c, i) => c.y + ras[i])) + pad + labelSpace;
  const width = round(maxX - minX);
  const height = round(maxY - minY);
  const gears: Gear[] = teeth.map((n, i) => {
    const r = (module * n) / 2;
    const rr = r - 1.25 * module;
    const big = n >= 18;
    return {
      index: i,
      teeth: n,
      cx: round(centres[i].x - minX),
      cy: round(centres[i].y - minY),
      r: round(r),
      ra: round(r + module),
      rr: round(rr),
      phase: round(phases[i]),
      spin: i % 2 === 0 ? 1 : -1,
      toNext: i < teeth.length - 1 ? angles[i] : null,
      holes: big ? { count: n >= 22 ? 6 : 5, at: round(rr * 0.6), size: round(rr * 0.17) } : { count: 3, at: round(rr * 0.58), size: round(rr * 0.15) },
      hub: round(Math.max(module * 2.2, r * 0.3)),
      bore: round(Math.max(module * 0.9, r * 0.12)),
      path: gearPath(n, module),
    };
  });
  return { variant, module, width, height, viewBox: `0 0 ${width} ${height}`, gears };
}

/** Wide (desktop, 900px and up): one row, zigzagging 24 degrees up and down, with room for the stage labels. */
export const WIDE_LAYOUT: GearLayout = layoutChain("wide", 7, [24, -24, 24, -24, 24, -24], 14, 48);
/** Compact (tablets and phones, below 900px): a steeper zigzag on a smaller module; the stage names are in the selector below. */
export const COMPACT_LAYOUT: GearLayout = layoutChain("compact", 4.6, [40, -40, 40, -40, 40, -40], 6);

/**
 * The angle (degrees) of a gear when the first gear has turned `drive` degrees. Neighbours turn in opposite directions, at the
 * inverse ratio of their tooth counts, so the train stays in mesh.
 */
export function gearAngle(gear: Pick<Gear, "phase" | "spin" | "teeth">, drive: number, firstTeeth: number = GEAR_STAGES[0].teeth): number {
  return gear.phase + gear.spin * drive * (firstTeeth / gear.teeth);
}

/** How far the first gear turns for a move of `steps` stages: three of its teeth per stage, in the direction of travel. */
export function driveFor(steps: number): number {
  return steps * 3 * (360 / GEAR_STAGES[0].teeth);
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Version B (3D): which version to show, and how much of it                                                                     */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export type GearsMode = "2d" | "3d";

/** Reads ?gears=2d|3d and ?compare from a location search string. Anything else means the 2D drawing, with no compare switch. */
export function parseGearsParam(search: string): { mode: GearsMode; compare: boolean } {
  const params = new URLSearchParams(search);
  return { mode: params.get("gears") === "3d" ? "3d" : "2d", compare: params.has("compare") };
}

/** full: shadows, high pixel ratio, camera moves and pointer parallax. lite: phones and low-power devices. none: use the 2D drawing. */
export type RenderTier = "full" | "lite" | "none";

export type DeviceSignals = {
  webgl: boolean;
  reducedMotion: boolean;
  /** Width of the viewport, CSS pixels. */
  width: number;
  /** navigator.hardwareConcurrency and navigator.deviceMemory where the browser reports them. */
  cores?: number;
  memory?: number;
};

export function chooseTier(d: DeviceSignals): RenderTier {
  if (!d.webgl || d.reducedMotion) return "none";
  if (d.width < 900) return "lite";
  if ((d.cores !== undefined && d.cores <= 4) || (d.memory !== undefined && d.memory <= 4)) return "lite";
  return "full";
}

/** What the version switch says (the 3D scene's own words are in lib/marketing/gear-scene.ts). */
export const VERSION_COPY = {
  loading: "Setting up the machine",
  compare: "Compare versions",
  versionA: "A · Current",
  versionB: "B · 3D",
  fallback: "3D isn't available on this device, or reduced motion is on, so this is version A.",
} as const;
