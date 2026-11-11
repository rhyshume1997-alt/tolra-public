/**
 * The 3D Tolra Machine's geometry (lib/marketing/gear-scene.ts): the ?gears= switch defaults to the 2D drawing; devices without
 * WebGL or with reduced motion get the 2D drawing; the involute teeth are true to size and never touch their neighbour's at any
 * angle of the train; the gears arch over the display without touching it or each other; the etched labels clear the gears and the
 * display; and every camera stop keeps what it is meant to show inside the frame, on a wide screen and on a phone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import {
  ANALYTICS_STAGE, PLANNED_COPY, SCENE_STAGES, STAGE_COUNT, VERSION_COPY, chooseTier, driveFor, gearAngle, parseGearsParam,
} from "@/lib/marketing/gear-workflow";
import {
  BESIDE_SCREEN, FOV, MACHINE, SCENE_COPY, displayBox, overviewStop, projectPoints, quadMatrix, revealStop, stageStop, toothOutline,
  type Box, type CameraStop,
} from "@/lib/marketing/gear-scene";

describe("the ?gears= switch", () => {
  it("shows the 2D drawing unless 3D is asked for, and only shows the compare switch on request", () => {
    expect(parseGearsParam("")).toEqual({ mode: "2d", compare: false });
    expect(parseGearsParam("?gears=3d")).toEqual({ mode: "3d", compare: false });
    expect(parseGearsParam("?gears=2d&compare")).toEqual({ mode: "2d", compare: true });
    expect(parseGearsParam("?gears=4d&compare=1")).toEqual({ mode: "2d", compare: true });
  });
});

describe("words", () => {
  it("keep the page's content rules", () => {
    const analytics = [ANALYTICS_STAGE.caption, ...ANALYTICS_STAGE.details, ...ANALYTICS_STAGE.record.flat(), ANALYTICS_STAGE.shot.alt];
    for (const line of [...Object.values(SCENE_COPY), ...Object.values(VERSION_COPY), ...Object.values(PLANNED_COPY), ...analytics]) {
      expect(line).not.toMatch(/£|\$|€|\d\s*%/);
      expect(line).not.toMatch(/\b(?:we|our|us|price|pricing|testimonial|import|backups?|GitHub|Xero|Sage|QuickBooks|Screenshot)\b/i);
    }
  });
});

describe("the planned Analytics view", () => {
  it("comes after the seven stages of a job and says everywhere that it is planned, with example values, not a feature today", () => {
    expect(SCENE_STAGES).toHaveLength(STAGE_COUNT + 1);
    expect(SCENE_STAGES.slice(0, STAGE_COUNT).every((s) => !s.planned)).toBe(true);
    expect(SCENE_STAGES[STAGE_COUNT]).toBe(ANALYTICS_STAGE);
    expect(ANALYTICS_STAGE.planned).toBe(true);
    expect(ANALYTICS_STAGE.stamp).toBe("PLANNED");
    expect(ANALYTICS_STAGE.caption).toMatch(/^Planned:/);
    expect(ANALYTICS_STAGE.details[0]).toMatch(/Not in Tolra yet/);
    for (const line of ANALYTICS_STAGE.details.slice(1)) expect(line).toMatch(/^Planned/);
    expect(ANALYTICS_STAGE.shot.alt).toMatch(/^Illustration of a planned/);
    expect(ANALYTICS_STAGE.shot.alt).toMatch(/example values only/);
    expect(ANALYTICS_STAGE.shot.alt).toMatch(/Not a feature in Tolra yet\.$/);
    expect(ANALYTICS_STAGE.record.map(([, v]) => v).join(" ")).toMatch(/Planned, not in Tolra yet/);
  });

  it("has its illustration in public/marketing/workflow, at the size the markup states", () => {
    const b = readFileSync(join(process.cwd(), "public", ANALYTICS_STAGE.shot.src));
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.toString("ascii", 8, 12)).toBe("WEBP");
    const chunk = b.toString("ascii", 12, 16);
    const size = chunk === "VP8 "
      ? { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
      : chunk === "VP8L"
        ? { width: (b.readUInt32LE(21) & 0x3fff) + 1, height: ((b.readUInt32LE(21) >> 14) & 0x3fff) + 1 }
        : { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    expect(size).toEqual({ width: ANALYTICS_STAGE.shot.width, height: ANALYTICS_STAGE.shot.height });
  });
});

describe("render tier", () => {
  const desk = { webgl: true, width: 1440, cores: 8, memory: 8 };
  it("falls back to the 2D drawing only without WebGL (reduced motion keeps the 3D version, with every move made instantly)", () => {
    expect(chooseTier({ ...desk, webgl: false })).toBe("none");
  });
  it("uses the lighter scene on phones, tablets and low-power machines, and the full scene on a capable desktop", () => {
    expect(chooseTier({ ...desk, width: 390 })).toBe("lite");
    expect(chooseTier({ ...desk, width: 768 })).toBe("lite");
    expect(chooseTier({ ...desk, cores: 4 })).toBe("lite");
    expect(chooseTier({ ...desk, memory: 2 })).toBe("lite");
    expect(chooseTier({ webgl: true, width: 1440 })).toBe("full");
    expect(chooseTier(desk)).toBe("full");
  });
});

/* Geometry helpers ----------------------------------------------------------------------------------------------------------------- */

type P = [number, number];
const rotate = (pts: P[], deg: number, dx: number, dy: number): P[] => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return pts.map(([x, y]) => [x * c - y * s + dx, x * s + y * c + dy]);
};
function inside([x, y]: P, poly: P[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const distToBox = (x: number, y: number, b: Box) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe("involute teeth", () => {
  it("reach exactly the tip circle and the root circle, every tooth the same, symmetric about its centre line", () => {
    for (const n of new Set(SCENE_STAGES.map((s) => s.teeth))) {
      const pts = toothOutline(n);
      const radii = pts.map(([x, y]) => Math.hypot(x, y));
      expect(Math.max(...radii)).toBeCloseTo(n / 2 + 1, 6);
      expect(Math.min(...radii)).toBeCloseTo(n / 2 - 1.25, 6);
      expect(pts.length % n).toBe(0);
      const per = pts.length / n;
      // Tooth 0 is centred on +x: its outline mirrors itself across the x axis.
      const tooth = pts.slice(0, per - 3);
      tooth.forEach(([x, y], k) => {
        const [mx, my] = tooth[tooth.length - 1 - k];
        expect(mx).toBeCloseTo(x, 6);
        expect(my).toBeCloseTo(-y, 6);
      });
    }
  });

  it("are as thick as the gaps between them at the pitch circle, less a small backlash", () => {
    const n = 20;
    const pts = toothOutline(n, 1, 40, 0.06);
    const pitch = pts.filter(([x, y]) => Math.abs(Math.hypot(x, y) - n / 2) < 0.08 && x > 0 && Math.abs(y) < 2);
    const width = Math.max(...pitch.map((p) => p[1])) - Math.min(...pitch.map((p) => p[1]));
    expect(width).toBeGreaterThan(Math.PI / 2 - 0.2);
    expect(width).toBeLessThan(Math.PI / 2);
  });

  it("never cut into the next gear's teeth, at rest or at any angle of the train", () => {
    for (const drive of [0, 3.3, 7, 11.9, driveFor(1), driveFor(3), -37]) {
      for (let i = 0; i < MACHINE.gears.length - 1; i += 1) {
        const a = MACHINE.gears[i];
        const b = MACHINE.gears[i + 1];
        // Work in the 2D drawing's convention (y down): the scene mirrors it, and a mirror keeps contact and clearance.
        const pa = rotate(toothOutline(a.teeth, 1, 8), gearAngle(a, drive), 0, 0);
        const alpha = (a.toNext! * Math.PI) / 180;
        const pb = rotate(toothOutline(b.teeth, 1, 8), gearAngle(b, drive), (a.r + b.r) * Math.cos(alpha), (a.r + b.r) * Math.sin(alpha));
        expect(pb.filter((p) => inside(p, pa))).toHaveLength(0);
        expect(pa.filter((p) => inside(p, pb))).toHaveLength(0);
      }
    }
  });
});

describe("the machine layout", () => {
  const { gears, display, labels } = MACHINE;
  const disp = displayBox();

  it("meshes each pair at the sum of their pitch radii and keeps the others apart", () => {
    for (let i = 0; i < gears.length; i += 1) {
      for (let j = i + 1; j < gears.length; j += 1) {
        const d = Math.hypot(gears[j].x - gears[i].x, gears[j].y - gears[i].y);
        if (j === i + 1) expect(d).toBeCloseTo(gears[i].r + gears[j].r, 2);
        else expect(d).toBeGreaterThan(gears[i].ra + gears[j].ra + 1.5);
      }
    }
  });

  it("arches the gears over the display without touching its bezel", () => {
    expect(display.w / display.h).toBeCloseTo(1.6, 2);
    for (const g of gears) expect(distToBox(g.x, g.y, disp)).toBeGreaterThan(g.ra + 1);
    // The first and last gears flank the display; the middle one sits above it.
    expect(gears[0].x).toBeLessThan(disp.x0);
    expect(gears[6].x).toBeGreaterThan(disp.x1);
    expect(gears[3].y - gears[3].ra).toBeGreaterThan(disp.y1);
    // The planned Analytics gear hangs below the invoice gear, driven by it.
    expect(gears).toHaveLength(STAGE_COUNT + 1);
    expect(gears[7].y).toBeLessThan(gears[6].y);
    expect(gears[7].x).toBeCloseTo(gears[6].x, 2);
  });

  it("etches each stage's label clear of every gear, the display and the other labels, inside the plate", () => {
    const boxes = labels.map((l) => ({ x0: l.x - l.w / 2, y0: l.y - l.h / 2, x1: l.x + l.w / 2, y1: l.y + l.h / 2 }));
    boxes.forEach((b, i) => {
      expect(labels[i].lines.join(" ")).toBe(SCENE_STAGES[i].label.toUpperCase());
      expect(labels[i].op).toBe(SCENE_STAGES[i].planned ? "PLANNED" : `OP ${SCENE_STAGES[i].op}`);
      expect(overlap(b, disp)).toBe(false);
      for (const g of gears) expect(distToBox(g.x, g.y, b)).toBeGreaterThan(g.ra);
      for (let j = i + 1; j < boxes.length; j += 1) expect(overlap(b, boxes[j])).toBe(false);
      expect(Math.abs(b.x0) * 2).toBeLessThan(MACHINE.plate.w);
      expect(Math.abs(b.y0) * 2).toBeLessThan(MACHINE.plate.h);
    });
  });
});

describe("camera stops", () => {
  const project = (stop: CameraStop, aspect: number, points: Array<[number, number, number]>) => {
    const cam = new PerspectiveCamera(FOV, aspect, 0.5, 2000);
    cam.up.set(0, 0, 1);
    cam.position.set(...stop.position);
    cam.lookAt(new Vector3(...stop.target));
    cam.updateMatrixWorld(true);
    return points.map((p) => new Vector3(...p).project(cam));
  };
  const ring = (i: number): Array<[number, number, number]> => {
    const g = MACHINE.gears[i];
    return Array.from({ length: 24 }, (_, k) => {
      const a = (k / 24) * 2 * Math.PI;
      return [g.x + g.ra * Math.cos(a), g.y + g.ra * Math.sin(a), MACHINE.lift + g.face + 1.5] as [number, number, number];
    });
  };
  const screen = (): Array<[number, number, number]> => {
    const b = displayBox();
    const z = MACHINE.display.height;
    return [[b.x0, b.y0, z], [b.x1, b.y0, z], [b.x0, b.y1, z], [b.x1, b.y1, z]];
  };
  const inFrame = (pts: Vector3[]) => pts.every((p) => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1);

  it("projects points exactly as a three.js perspective camera does", () => {
    const stop = stageStop(2, 1.7);
    const pts: Array<[number, number, number]> = [[0, 0, 0], [30, -12, 4], [-41, 20, 2], [5, 33, 7]];
    const ours = projectPoints(stop, 1.7, pts);
    project(stop, 1.7, pts).forEach((p, k) => {
      expect(ours[k][0]).toBeCloseTo(p.x, 6);
      expect(ours[k][1]).toBeCloseTo(p.y, 6);
    });
  });

  for (const [name, aspect, tier] of [["desktop", 1.8, "full"], ["wide desktop", 2.05, "full"], ["tablet", 1.25, "lite"], ["phone", 1.05, "lite"]] as const) {
    it(`${name}: the overview and the final reveal show every gear and the display`, () => {
      for (const stop of [overviewStop(aspect), revealStop(aspect)]) {
        const all = [...MACHINE.gears.map((_, i) => ring(i)).flat(), ...screen()];
        expect(inFrame(project(stop, aspect, all))).toBe(true);
      }
    });

    it(`${name}: each stage keeps its gear and the display in frame, and comes closer than the overview`, () => {
      const far = Math.hypot(...overviewStop(aspect).position.map((v, k) => v - overviewStop(aspect).target[k]));
      for (let i = 0; i < MACHINE.gears.length; i += 1) {
        const stop = stageStop(i, aspect, tier);
        expect(inFrame(project(stop, aspect, [...ring(i), ...screen()]))).toBe(true);
        const near = Math.hypot(...stop.position.map((v, k) => v - stop.target[k]));
        expect(near).toBeLessThan(far);
        for (const v of [...stop.position, ...stop.target]) expect(Number.isFinite(v)).toBe(true);
      }
    });
  }

  it.each([1.8, 1.5])("beside the lifted screen (aspect %s): each gear sits in the left part of the frame, clear of the screen, closer than the overview", (aspect) => {
    const far = Math.hypot(...overviewStop(aspect).position.map((v, k) => v - overviewStop(aspect).target[k]));
    for (let i = 0; i < MACHINE.gears.length; i += 1) {
      const stop = stageStop(i, aspect, "full", true);
      for (const p of project(stop, aspect, ring(i))) {
        expect(p.x).toBeGreaterThanOrEqual(BESIDE_SCREEN.cx - BESIDE_SCREEN.hw - 1e-6);
        expect(p.x).toBeLessThanOrEqual(BESIDE_SCREEN.cx + BESIDE_SCREEN.hw + 1e-6);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
      }
      expect(Math.hypot(...stop.position.map((v, k) => v - stop.target[k]))).toBeLessThan(far);
    }
  });
});

describe("pinning the HTML screen onto the scene", () => {
  const apply = (m: number[], x: number, y: number) => {
    const w = m[3] * x + m[7] * y + m[15];
    return [(m[0] * x + m[4] * y + m[12]) / w, (m[1] * x + m[5] * y + m[13]) / w];
  };
  it("maps the element's corners onto any four points, in order, and an upright rectangle with a plain scale and move", () => {
    const quads: Array<Array<[number, number]>> = [
      [[100, 80], [520, 60], [560, 330], [90, 300]],
      [[300, 400], [700, 420], [760, 600], [240, 590]],
      [[10, 20], [410, 20], [410, 270], [10, 270]],
    ];
    for (const q of quads) {
      const m = quadMatrix(800, 500, q);
      const corners = [[0, 0], [800, 0], [800, 500], [0, 500]];
      corners.forEach(([x, y], k) => {
        const [px, py] = apply(m, x, y);
        expect(px).toBeCloseTo(q[k][0], 6);
        expect(py).toBeCloseTo(q[k][1], 6);
      });
    }
    const flat = quadMatrix(800, 500, quads[2]);
    expect(flat[3]).toBeCloseTo(0, 9);
    expect(flat[7]).toBeCloseTo(0, 9);
    expect(flat[0]).toBeCloseTo(0.5, 9);
    expect(flat[5]).toBeCloseTo(0.5, 9);
  });
});
