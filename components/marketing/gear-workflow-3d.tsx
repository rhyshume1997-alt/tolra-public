"use client";

/*
 * "The Tolra Machine" in 3D (version B, the default for the home page gear workflow): eight machined steel gears on an anodised
 * plate, arched over a display set into the plate. Seven are the stages of one job; the eighth, driven by the invoice gear, is
 * Analytics. Selecting a gear turns the train (true involute teeth, opposite directions, inverse ratios), lights that gear and moves
 * the camera to it.
 *
 * From 900px wide, that stage's screen then lifts out of its slot in the plate and stands upright beside the machine, showing a
 * cropped view of the stage's picture, with Previous / Next arrows, View full size and a close button. It is plain HTML placed with a
 * CSS matrix3d computed from the 3D camera, so it stays sharp and clickable; once upright it stays put and only its picture changes.
 * From the last screen, "Run the whole machine" lowers it, runs the train once while the display steps through every stage, pulls
 * back and offers the booking link. Below 900px the display in the plate shows each stage instead, with the picture under the
 * machine, and reaching the last stage runs the reveal.
 *
 * Built to stay quick: the scene is assembled in small steps between frames (shaders compiled in the background), only the pictures
 * needed are prepared, nothing follows the pointer, and nothing renders unless it is moving.
 *
 * Inputs: the selected view from GearWorkflow (stage chips, Previous / Next and the gears all go through its pick), the render tier,
 * whether motion is allowed, and callbacks. Geometry, camera stops, the corner-pinning matrix and words come from
 * lib/marketing/gear-scene.ts; views and images from lib/marketing/gear-workflow.ts (SCENE_STAGES). Output: one canvas (hidden from
 * assistive technology: the stage chips are the accessible control), the lifting screen, and a few labels. No data, no network
 * beyond the images in public/marketing/workflow/.
 * Must not change: it is only ever loaded on demand by components/marketing/gear-workflow.tsx, never server rendered, renders only
 * while something moves, makes every move instantly under prefers-reduced-motion, and hands back to the 2D drawing if WebGL fails.
 */
import { useEffect, useRef, useState } from "react";
import {
  AdditiveBlending, BackSide, BoxGeometry, CanvasTexture, CylinderGeometry, DirectionalLight, ExtrudeGeometry, Group, LatheGeometry, Mesh, MeshBasicMaterial,
  Matrix4, MeshPhysicalMaterial, MeshStandardMaterial, NeutralToneMapping, NoColorSpace, Object3D, PCFShadowMap, PerspectiveCamera, Path, PlaneGeometry,
  PMREMGenerator, Quaternion, Raycaster, RepeatWrapping, Scene, ShaderMaterial, Shape, SpotLight, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
  type BufferGeometry, type Material, type Texture,
} from "three";

import NextImage from "next/image";

import { Cta } from "@/components/marketing/cta";
import {
  FOV, MACHINE, SCENE_COPY, overviewStop, quadMatrix, revealStop, stageStop, toothOutline, type CameraStop, type RenderTier,
  type SceneGear,
} from "@/lib/marketing/gear-scene";
import {
  GEAR_COPY, SCENE_STAGES, driveFor, gearAngle, type SceneStage,
} from "@/lib/marketing/gear-workflow";

type Tier = Exclude<RenderTier, "none">;

export type GearWorkflow3DProps = {
  active: number;
  tier: Tier;
  /** False under prefers-reduced-motion: every move (train, camera, screen) happens at once, and nothing plays by itself. */
  motion: boolean;
  onPick: (index: number) => void;
  onOpenFull: () => void;
  onRestart: () => void;
  /** WebGL could not start or was lost: the caller goes back to the 2D drawing. */
  onFail: () => void;
};

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Progress of a tween; a zero duration (reduced motion) is already done. */
const progress = (now: number, t0: number, dur: number) => (dur <= 0 ? 1 : clamp01((now - t0) / dur));
/** Quick start, soft stop, no overshoot: the screen arrives and stays put. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
/** The last view (Analytics): its screen offers to run the whole machine. */
const LAST = SCENE_STAGES.length - 1;
/** Yield to the browser between heavy steps, so scrolling and input never wait for the scene to be built. */
const breathe = () => new Promise<void>((resolve) => {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => resolve(), { timeout: 100 });
  else window.setTimeout(resolve, 16);
});
/** The screen lifts out and stands upright only where there is room beside the machine (canvas at least this wide, CSS px). */
const LIFT_MIN_WIDTH = 900;
/** Where the upright screen stands, as fractions of the canvas: the right part, clear of the machine (see BESIDE_SCREEN). */
const SHEET = { left: 0.45, top: 0.05, width: 0.53, height: 0.9 };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const DEG = Math.PI / 180;
/** Radius covered by the shared turned-finish texture, so every gear's rings are the same pitch. */
const TEX_R = 14;

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Procedural textures: no image downloads for the metal                                                                            */
/* ------------------------------------------------------------------------------------------------------------------------------ */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Seeded noise, so the finish is the same on every visit. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Lathe-turned finish: fine concentric tool marks, as roughness and relief. */
function turnedTexture(size: number): CanvasTexture {
  const [c, x] = canvas(size, size);
  const rand = rng(7);
  x.fillStyle = "rgb(150,150,150)";
  x.fillRect(0, 0, size, size);
  const mid = size / 2;
  let wave = 0;
  for (let r = 1; r < mid * 1.42; r += 1.15) {
    // Slow bands (a tool pass at a time) over fine, irregular grooves.
    wave += (rand() - 0.5) * 26;
    wave *= 0.965;
    const v = Math.round(Math.max(70, Math.min(235, 150 + wave + (rand() - 0.5) * 40)));
    x.strokeStyle = `rgb(${v},${v},${v})`;
    x.lineWidth = 1.1;
    x.beginPath();
    x.arc(mid, mid, r, 0, Math.PI * 2);
    x.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  return t;
}

/**
 * Direction of the turning marks, for anisotropic reflections: red and green hold a direction in the part's UV space (+x, +y),
 * blue the strength. Radial here, so the highlight on a turned face streaks across the circular marks, as on a real gear.
 */
function radialDirectionTexture(size: number): CanvasTexture {
  const [c, x] = canvas(size, size);
  const img = x.createImageData(size, size);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const u = (px + 0.5) / size - 0.5;
      const v = 0.5 - (py + 0.5) / size;
      const l = Math.hypot(u, v) || 1;
      img.data.set([((u / l) * 0.5 + 0.5) * 255, ((v / l) * 0.5 + 0.5) * 255, 255, 255], (py * size + px) * 4);
    }
  }
  x.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  return t;
}

/** Bead-blasted finish for the gear webs: fine even grain. */
function grainTexture(size: number): CanvasTexture {
  const [c, x] = canvas(size, size);
  const img = x.createImageData(size, size);
  const rand = rng(11);
  for (let i = 0; i < size * size; i += 1) {
    const v = 120 + rand() * 90;
    img.data.set([v, v, v, 255], i * 4);
  }
  x.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  return t;
}

/** The anodised plate: brushed grain, a turned spot face under each gear and a machined groove inside the edge. */
function plateTextures(px: number): { color: CanvasTexture; rough: CanvasTexture } {
  const { w: PW, h: PH } = MACHINE.plate;
  const W = px;
  const H = Math.round((px * PH) / PW);
  const sx = (x: number) => (x / PW + 0.5) * W;
  const sy = (y: number) => (0.5 - y / PH) * H;
  const unit = W / PW;
  const [cc, c] = canvas(W, H);
  const [rc, r] = canvas(W, H);
  const rand = rng(23);
  c.fillStyle = "#1c2738";
  c.fillRect(0, 0, W, H);
  r.fillStyle = "rgb(150,150,150)";
  r.fillRect(0, 0, W, H);
  // Brushed grain, along the plate's length.
  for (let i = 0; i < H * 1.6; i += 1) {
    const y = rand() * H;
    const a = 0.008 + rand() * 0.02;
    c.fillStyle = rand() > 0.5 ? `rgba(255,255,255,${a * 0.5})` : `rgba(0,0,0,${a})`;
    c.fillRect(0, y, W, 0.6 + rand());
    const v = Math.round(140 + rand() * 24);
    r.fillStyle = `rgb(${v},${v},${v})`;
    r.fillRect(0, y, W, 0.6 + rand());
  }
  // A groove machined a little inside the edge.
  const inset = 3.2 * unit;
  for (const [ctx, style] of [[c, "rgba(0,0,0,0.55)"], [r, "rgb(90,90,90)"]] as const) {
    ctx.strokeStyle = style;
    ctx.lineWidth = Math.max(1.5, 0.28 * unit);
    ctx.beginPath();
    ctx.roundRect(inset, inset, W - 2 * inset, H - 2 * inset, 2.4 * unit);
    ctx.stroke();
  }
  // Spot faces: each gear sits on a turned, slightly brighter seat.
  for (const g of MACHINE.gears) {
    const cx = sx(g.x);
    const cy = sy(g.y);
    const rad = (g.ra + 0.9) * unit;
    c.fillStyle = "#1f2b3d";
    c.beginPath();
    c.arc(cx, cy, rad, 0, Math.PI * 2);
    c.fill();
    for (let k = 1; k < rad; k += 1.2) {
      const v = Math.round(105 + rand() * 40);
      r.strokeStyle = `rgb(${v},${v},${v})`;
      r.lineWidth = 1;
      r.beginPath();
      r.arc(cx, cy, k, 0, Math.PI * 2);
      r.stroke();
    }
    c.strokeStyle = "rgba(0,0,0,0.5)";
    c.lineWidth = Math.max(1, 0.12 * unit);
    c.beginPath();
    c.arc(cx, cy, rad, 0, Math.PI * 2);
    c.stroke();
  }
  const color = new CanvasTexture(cc);
  color.colorSpace = SRGBColorSpace;
  const rough = new CanvasTexture(rc);
  rough.colorSpace = NoColorSpace;
  return { color, rough };
}

function fontOf(selector: string, fallback: string): string {
  const el = document.querySelector(selector);
  return el ? getComputedStyle(el).fontFamily : fallback;
}

/** Laser-etched marking: OP number and stage name, white on transparent, sized in world units. */
function labelTexture(op: string, lines: string[], pxPerUnit: number, fonts: { display: string; mono: string }) {
  const nameSize = 1.7 * pxPerUnit;
  const opSize = 1.05 * pxPerUnit;
  const gap = 0.45 * pxPerUnit;
  const [m, mx] = canvas(8, 8);
  void m;
  mx.font = `600 ${nameSize}px ${fonts.display}`;
  const widths = lines.map((l) => mx.measureText(l).width + l.length * nameSize * 0.04);
  mx.font = `500 ${opSize}px ${fonts.mono}`;
  const opWidth = mx.measureText(op).width + op.length * opSize * 0.16;
  const W = Math.ceil(Math.max(opWidth, ...widths) + nameSize * 0.4);
  const H = Math.ceil(opSize + gap + lines.length * nameSize * 1.1 + nameSize * 0.2);
  const [c, x] = canvas(W, H);
  x.fillStyle = "#fff";
  x.textAlign = "center";
  x.textBaseline = "top";
  x.font = `500 ${opSize}px ${fonts.mono}`;
  x.letterSpacing = `${opSize * 0.16}px`;
  x.fillText(op, W / 2, 0);
  x.font = `600 ${nameSize}px ${fonts.display}`;
  x.letterSpacing = `${nameSize * 0.04}px`;
  lines.forEach((l, i) => x.fillText(l, W / 2, opSize + gap + i * nameSize * 1.1));
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return { texture: t, w: W / pxPerUnit, h: H / pxPerUnit };
}

/** The display's picture: a document as a sheet on a light desk, or a screen as an app window, always 16:10. */
function composeStage(img: HTMLImageElement, stage: SceneStage, W: number, H: number, mono: string): HTMLCanvasElement {
  const [c, x] = canvas(W, H);
  x.fillStyle = "#e7ebf1";
  x.fillRect(0, 0, W, H);
  if (stage.shot.kind === "document") {
    const pw = W * 0.78;
    const ph = (img.naturalHeight * pw) / img.naturalWidth;
    const left = (W - pw) / 2;
    const top = H * 0.07;
    x.save();
    x.shadowColor = "rgba(12,22,38,0.28)";
    x.shadowBlur = W * 0.02;
    x.shadowOffsetY = W * 0.006;
    x.fillStyle = "#fff";
    x.fillRect(left, top, pw, ph);
    x.restore();
    x.drawImage(img, left, top, pw, ph);
    const fade = x.createLinearGradient(0, H * 0.8, 0, H);
    fade.addColorStop(0, "rgba(231,235,241,0)");
    fade.addColorStop(1, "rgba(231,235,241,1)");
    x.fillStyle = fade;
    x.fillRect(0, H * 0.8, W, H * 0.2);
  } else {
    const bar = H * 0.075;
    x.fillStyle = "#17233a";
    x.fillRect(0, 0, W, bar);
    x.fillStyle = "#3ccf7a";
    x.beginPath();
    x.arc(bar * 0.62, bar / 2, bar * 0.14, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#c3cee0";
    x.font = `500 ${bar * 0.36}px ${mono}`;
    x.textBaseline = "middle";
    x.fillText(`Tolra · ${stage.shot.source}`, bar * 1.05, bar / 2);
    const m = W * 0.035;
    const aw = W - 2 * m;
    // Each screen fills the display's width and shows its top (title and first figures), as the lifted screen does.
    const s = aw / img.naturalWidth;
    const iw = img.naturalWidth * s;
    const ih = img.naturalHeight * s;
    const top = bar + m;
    x.save();
    x.shadowColor = "rgba(12,22,38,0.2)";
    x.shadowBlur = W * 0.012;
    x.fillStyle = "#fff";
    x.fillRect(m, top, Math.min(iw, aw), Math.min(ih, H - top));
    x.restore();
    x.save();
    x.beginPath();
    x.rect(m, top, aw, Math.min(ih, H - top));
    x.clip();
    x.drawImage(img, m, top, iw, ih);
    x.restore();
  }
  return c;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Geometry                                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Planar UVs centred on the part's axis, so the turned rings centre on each gear. */
function radialUV(geo: BufferGeometry, scale = TEX_R) {
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < pos.count; i += 1) uv.setXY(i, pos.getX(i) / (2 * scale) + 0.5, pos.getY(i) / (2 * scale) + 0.5);
  uv.needsUpdate = true;
}

/** A lathe profile, given as (radius, height) pairs, turned about the z axis. */
function turned(profile: Array<[number, number]>, segments: number): LatheGeometry {
  const geo = new LatheGeometry(profile.map(([r, z]) => new Vector2(r, z)), segments);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function circlePath(r: number, x = 0, y = 0): Path {
  const p = new Path();
  p.absarc(x, y, r, 0, Math.PI * 2, true);
  return p;
}

function roundRect(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

type Mats = Record<"face" | "flank" | "web" | "polished" | "oxide" | "bronze" | "plate" | "edge" | "bezel", MeshStandardMaterial>;

/** One gear: toothed rim, recessed web with lightening holes, hub boss, socket cap screws, shaft, washer and nut. */
function buildGear(g: SceneGear, m: Mats, full: boolean): { root: Group; spin: Group; pick: Mesh } {
  const root = new Group();
  root.position.set(g.x, g.y, 0);
  const spin = new Group();
  spin.position.z = MACHINE.lift;
  root.add(spin);
  const F = g.face;
  const seg = full ? 64 : 32;

  // Rim and teeth: the involute outline, mirrored into the scene's y-up frame, extruded with a fine chamfer on every edge.
  const outline = toothOutline(g.teeth, 1, full ? 5 : 3).map(([x, y]) => new Vector2(x, -y));
  const rim = new Shape(outline);
  const rimIn = g.rr - 1.35;
  rim.holes.push(circlePath(rimIn));
  const bevel = 0.16;
  const rimGeo = new ExtrudeGeometry(rim, {
    depth: F - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelOffset: -bevel * 0.85,
    bevelSegments: full ? 2 : 1, curveSegments: full ? 48 : 24,
  });
  rimGeo.translate(0, 0, bevel);
  radialUV(rimGeo);
  const rimMesh = new Mesh(rimGeo, [m.face, m.flank]);
  rimMesh.castShadow = full;
  rimMesh.receiveShadow = full;
  rimMesh.userData.index = g.index;
  spin.add(rimMesh);

  // Web: thinner than the rim, so the rim stands proud on both faces, with lightening holes where there is room.
  const web = new Shape();
  web.absarc(0, 0, rimIn + 0.4, 0, Math.PI * 2, false);
  web.holes.push(circlePath(g.bore));
  const inner = g.hub + 0.55;
  const outer = rimIn - 0.55;
  if (outer - inner > 1.5) {
    const at = (inner + outer) / 2;
    const size = ((outer - inner) / 2) * 0.8;
    const count = Math.max(3, Math.min(6, Math.floor((2 * Math.PI * at) / (2 * size + 1.4))));
    for (let k = 0; k < count; k += 1) {
      const a = (k / count) * Math.PI * 2 + Math.PI / count;
      web.holes.push(circlePath(size, at * Math.cos(a), at * Math.sin(a)));
    }
  }
  const wt = F * 0.42;
  const webGeo = new ExtrudeGeometry(web, { depth: wt - 0.16, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelOffset: -0.08, bevelSegments: 1, curveSegments: full ? 40 : 20 });
  webGeo.translate(0, 0, F * 0.29 + 0.08);
  radialUV(webGeo);
  const webMesh = new Mesh(webGeo, [m.web, m.flank]);
  webMesh.castShadow = full;
  webMesh.receiveShadow = full;
  webMesh.userData.index = g.index;
  spin.add(webMesh);

  // Hub boss, turned, standing a little above the rim face.
  const top = F * 1.12;
  const hub = new Mesh(turned([[g.bore, -0.05], [g.hub - 0.25, -0.05], [g.hub, 0.2], [g.hub, top - 0.25], [g.hub - 0.25, top], [g.bore + 0.25, top], [g.bore, top - 0.1]], seg), m.polished);
  hub.castShadow = full;
  hub.userData.index = g.index;
  spin.add(hub);
  // Socket cap screws clamping the hub, where it is big enough to take them.
  if (g.hub >= 2.8) {
    const at = (g.bore + g.hub) / 2 + 0.15;
    for (let k = 0; k < 3; k += 1) {
      const a = (k / 3) * Math.PI * 2 + 0.5;
      const head = new Mesh(new CylinderGeometry(0.36, 0.36, 0.28, 20), m.oxide);
      head.rotation.x = Math.PI / 2;
      head.position.set(at * Math.cos(a), at * Math.sin(a), top + 0.14);
      const socket = new Mesh(new CylinderGeometry(0.17, 0.17, 0.05, 6), new MeshBasicMaterial({ color: 0x07090c }));
      socket.rotation.x = Math.PI / 2;
      socket.position.set(at * Math.cos(a), at * Math.sin(a), top + 0.29);
      spin.add(head, socket);
    }
  }
  // Shaft, washer and hex nut: the nut turning is the clearest sign of which way each gear goes.
  const shaft = new Mesh(turned([[0, -MACHINE.lift], [g.bore, -MACHINE.lift], [g.bore, top + 1.2], [g.bore - 0.15, top + 1.35], [0, top + 1.35]], 32), m.polished);
  spin.add(shaft);
  const washer = new Mesh(turned([[g.bore + 0.02, top], [g.bore + 0.95, top], [g.bore + 0.95, top + 0.2], [g.bore + 0.02, top + 0.2]], seg), m.polished);
  spin.add(washer);
  const nut = new Mesh(new CylinderGeometry(g.bore * 1.75 + 0.3, g.bore * 1.75 + 0.3, 0.75, 6), m.oxide);
  nut.rotation.x = Math.PI / 2;
  nut.position.z = top + 0.2 + 0.375;
  nut.castShadow = full;
  spin.add(nut);
  // Flanged bronze bushing in the plate, which the shaft runs in (does not turn).
  const bush = new Mesh(turned([[g.bore + 0.02, 0], [g.bore + 1.5, 0], [g.bore + 1.5, 0.3], [g.bore + 0.8, 0.42], [g.bore + 0.8, MACHINE.lift - 0.05], [g.bore + 0.02, MACHINE.lift - 0.05]], seg), m.bronze);
  bush.receiveShadow = full;
  root.add(bush);

  return { root, spin, pick: rimMesh };
}

/** A countersunk screw head, flush with the surface it sits in. */
function screw(m: Mats, x: number, y: number, z: number, r = 0.6): Group {
  const g = new Group();
  const head = new Mesh(turned([[0, -0.25], [r * 0.82, -0.25], [r, 0.02], [0, 0.02]], 24), m.oxide);
  const slot = new Mesh(new CylinderGeometry(r * 0.42, r * 0.42, 0.06, 6), new MeshBasicMaterial({ color: 0x06080b }));
  slot.rotation.x = Math.PI / 2;
  slot.position.z = 0.01;
  g.add(head, slot);
  g.position.set(x, y, z);
  return g;
}

/**
 * The studio the metal reflects: a dark room with a large softbox overhead, a tall strip to the left, a cool rim strip behind and a
 * low fill in front, as in a product photograph. Steel looks like steel because of what it reflects, so this matters more than any
 * light. Built in the scene's own z-up frame and baked once into an environment map.
 */
function studio(): Scene {
  const s = new Scene();
  s.add(new Mesh(new BoxGeometry(120, 120, 120), new MeshBasicMaterial({ color: 0x0d0f13, side: BackSide })));
  const box = (w: number, h: number, hex: number, power: number, place: (m: Mesh) => void) => {
    const mat = new MeshBasicMaterial({ color: hex, side: BackSide });
    mat.color.multiplyScalar(power);
    const m = new Mesh(new PlaneGeometry(w, h), mat);
    place(m);
    s.add(m);
  };
  box(96, 64, 0xffffff, 0.45, (m) => { m.position.set(0, 0, 59); });
  box(64, 8, 0xffffff, 3.6, (m) => { m.position.set(-6, 20, 55); });
  box(64, 4, 0xffffff, 2.4, (m) => { m.position.set(-6, -16, 55); });
  box(14, 70, 0xfff4e8, 1.5, (m) => { m.position.set(-56, -4, 22); m.rotation.y = -Math.PI / 2; });
  box(80, 9, 0xd6e4ff, 2.6, (m) => { m.position.set(10, 56, 14); m.rotation.x = -Math.PI / 2; });
  box(90, 10, 0xffffff, 0.35, (m) => { m.position.set(0, -56, 6); m.rotation.x = Math.PI / 2; });
  return s;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* The engine: everything WebGL, outside React                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------------------ */

type Callbacks = {
  onPick: (i: number) => void;
  onOpenFull: () => void;
  onReady: () => void;
  onFail: () => void;
  onReveal: (on: boolean) => void;
  /** Which stage the lifted screen shows, and whether it is up (interactive) or down in its slot. */
  onScreen: (state: { stage: number; up: boolean }) => void;
};

type Tween = { from: CameraStop; to: CameraStop; t0: number; dur: number };

/**
 * The scene and everything that moves in it. `sheet` is the HTML screen: the engine pins it onto the display in the plate and, when
 * a stage is selected, lifts it out, turns it to face the viewer and stands it upright beside the machine, by projecting its four
 * corners with the 3D camera every frame and setting a CSS matrix3d (quadMatrix) on it.
 */
async function createEngine(cv: HTMLCanvasElement, sheet: HTMLElement, tier: Tier, start: number, motion: boolean, cb: Callbacks, signal: { aborted: boolean }) {
  const full = tier === "full";
  const ms = (n: number) => (motion ? n : 0);
  const renderer = new WebGLRenderer({ canvas: cv, antialias: true, alpha: true, powerPreference: full ? "high-performance" : "default" });
  let pixelRatio = Math.min(window.devicePixelRatio || 1, full ? 1.5 : 1.25);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = full;
  renderer.shadowMap.type = PCFShadowMap;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  // Between each heavy step below, hand control back to the browser; stop quietly if the section has gone away meanwhile.
  const step = async () => {
    await breathe();
    if (signal.aborted) {
      renderer.dispose();
      throw new Error("aborted");
    }
  };
  await step();
  const room = studio();
  const env = pmrem.fromScene(room, 0.03).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.9;

  const camera = new PerspectiveCamera(FOV, 2, 1, 2000);
  camera.up.set(0, 0, 1);

  // Lights: a soft key from the front left that casts the contact shadows, a cool rim from behind on the tooth edges, and an
  // inspection lamp that follows the selected gear.
  const key = new DirectionalLight(0xfff6ec, 1.15);
  key.position.set(-70, -55, 120);
  key.castShadow = full;
  if (full) {
    key.shadow.mapSize.set(1024, 1024);
    const s = key.shadow.camera;
    // Covers the machine (not the whole plate) from the light's point of view, so the shadow map's detail goes where it is seen.
    const R = Math.hypot(MACHINE.bounds.x1, MACHINE.bounds.y1) + 6;
    s.left = -R; s.right = R; s.top = R; s.bottom = -R;
    s.near = 40; s.far = 320;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 3;
  }
  scene.add(key, key.target);
  const rimLight = new DirectionalLight(0xbcd2ff, 0.7);
  rimLight.position.set(60, 90, 40);
  scene.add(rimLight);
  const lamp = new SpotLight(0xf3f7ff, 0, 0, 0.3, 0.75, 0);
  lamp.position.set(0, 0, 90);
  scene.add(lamp, lamp.target);

  // Materials.
  await step();
  const turnedTex = turnedTexture(full ? 512 : 256);
  const grain = grainTexture(256);
  grain.wrapS = grain.wrapT = RepeatWrapping;
  grain.repeat.set(6, 6);
  await step();
  const plateTex = plateTextures(full ? 1280 : 768);
  const radial = radialDirectionTexture(256);
  for (const t of [turnedTex, grain, plateTex.color, plateTex.rough]) t.anisotropy = maxAniso;
  const m: Mats = {
    // Turned faces: anisotropic, so the highlight streaks across the tool marks and sweeps round as the gear turns.
    face: new MeshPhysicalMaterial({ color: 0xc9cdd3, metalness: 1, roughness: 0.46, roughnessMap: turnedTex, bumpMap: turnedTex, bumpScale: 0.3, anisotropy: 0.75, anisotropyMap: radial }),
    flank: new MeshStandardMaterial({ color: 0xa4aab2, metalness: 1, roughness: 0.28 }),
    web: new MeshStandardMaterial({ color: 0x8e949c, metalness: 1, roughness: 0.6, roughnessMap: grain, bumpMap: grain, bumpScale: 0.2 }),
    polished: new MeshStandardMaterial({ color: 0xdadde2, metalness: 1, roughness: 0.12 }),
    oxide: new MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.8, roughness: 0.36 }),
    bronze: new MeshStandardMaterial({ color: 0xb98d55, metalness: 1, roughness: 0.3 }),
    plate: new MeshPhysicalMaterial({ color: 0xffffff, map: plateTex.color, metalness: 0.5, roughness: 0.8, roughnessMap: plateTex.rough, bumpMap: plateTex.rough, bumpScale: 0.08, anisotropy: 0.6, anisotropyRotation: Math.PI / 2 }),
    edge: new MeshStandardMaterial({ color: 0xc7ccd4, metalness: 1, roughness: 0.16 }),
    bezel: new MeshStandardMaterial({ color: 0x141a24, metalness: 0.6, roughness: 0.42 }),
  };

  // The plate: anodised aluminium with a bright diamond-cut chamfer round the edge.
  const { w: PW, h: PH } = MACHINE.plate;
  const plateGeo = new ExtrudeGeometry(roundRect(PW, PH, 3), { depth: 5, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.5, bevelOffset: -0.5, bevelSegments: 2, curveSegments: 12 });
  plateGeo.translate(0, 0, -5.5);
  {
    const pos = plateGeo.getAttribute("position");
    const uv = plateGeo.getAttribute("uv");
    for (let i = 0; i < pos.count; i += 1) uv.setXY(i, pos.getX(i) / PW + 0.5, pos.getY(i) / PH + 0.5);
  }
  const plate = new Mesh(plateGeo, [m.plate, m.edge]);
  plate.receiveShadow = full;
  scene.add(plate);
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) scene.add(screw(m, sx * (PW / 2 - 4.6), sy * (PH / 2 - 4.6), 0, 0.85));

  // The gears.
  await step();
  const gears: Array<ReturnType<typeof buildGear>> = [];
  for (const g of MACHINE.gears) {
    gears.push(buildGear(g, m, full));
    if (g.index % 3 === 2) await step();
  }
  for (const g of gears) scene.add(g.root);
  const pickables: Object3D[] = gears.flatMap((g) => g.spin.children.filter((c) => c.userData.index !== undefined));

  // Etched labels; the selected stage's lights up.
  const fonts = { display: fontOf(".mk-display", "sans-serif"), mono: fontOf(".mk-label, .mk-mono", "monospace") };
  const labelMats = MACHINE.labels.map(() => new MeshStandardMaterial({
    color: 0xb4bfce, transparent: true, metalness: 0.15, roughness: 0.7, emissive: 0xd6e4ff, emissiveIntensity: 0,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  const labelMeshes = MACHINE.labels.map((l, i) => {
    const mesh = new Mesh(new PlaneGeometry(1, 1), labelMats[i]);
    mesh.position.set(l.x, l.y, 0.03);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });
  // On phones the etched names would be a few pixels high; the stage chips under the machine name every stage there instead.
  const drawLabels = () => {
    if (!full) return;
    MACHINE.labels.forEach((l, i) => {
      const { texture, w, h } = labelTexture(l.op, l.lines, 48, fonts);
      texture.anisotropy = maxAniso;
      labelMats[i].map?.dispose();
      labelMats[i].map = texture;
      labelMats[i].emissiveMap = texture;
      labelMats[i].needsUpdate = true;
      labelMeshes[i].scale.set(w, h, 1);
      labelMeshes[i].visible = true;
    });
    kick();
  };

  // The display: a black anodised bezel with a diamond-cut chamfer, the picture recessed under glass.
  const d = MACHINE.display;
  const bezelShape = roundRect(d.w + 2 * d.bezel, d.h + 2 * d.bezel, 1.5);
  bezelShape.holes.push(roundRect(d.w, d.h, 0.35));
  const bezelGeo = new ExtrudeGeometry(bezelShape, { depth: d.height - 0.6, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelOffset: -0.3, bevelSegments: 2, curveSegments: 10 });
  bezelGeo.translate(d.x, d.y, 0.3);
  const bezel = new Mesh(bezelGeo, [m.bezel, m.edge]);
  bezel.castShadow = full;
  bezel.receiveShadow = full;
  scene.add(bezel);
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) scene.add(screw(m, d.x + sx * (d.w / 2 + d.bezel / 2), d.y + sy * (d.h / 2 + d.bezel / 2), d.height, 0.45));

  const blank = new CanvasTexture(canvas(4, 4)[0]);
  const screenMat = new ShaderMaterial({
    uniforms: { a: { value: blank }, b: { value: blank }, p: { value: 1 }, empty: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
      uniform sampler2D a; uniform sampler2D b; uniform float p; uniform float empty; varying vec2 vUv;
      void main() {
        float edge = 1.0 - p;
        vec3 c = mix(texture2D(a, vUv).rgb, texture2D(b, vUv).rgb, smoothstep(edge - 0.003, edge + 0.003, vUv.y));
        float line = (1.0 - smoothstep(0.0, 0.012, abs(vUv.y - edge))) * step(0.001, p) * step(p, 0.999);
        c = mix(c, vec3(0.62, 0.74, 1.0), line * 0.5);
        vec2 q = vUv - 0.5;
        c *= 1.0 - 0.16 * dot(q, q);
        // With the screen lifted out, the slot is an empty dark recess, lit softly from inside.
        vec3 recess = vec3(0.025, 0.04, 0.065) + vec3(0.05, 0.09, 0.16) * (1.0 - smoothstep(0.0, 0.5, length(q * vec2(1.0, 1.6))));
        c = mix(c, recess, empty);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    toneMapped: false,
  });
  const screen = new Mesh(new PlaneGeometry(d.w, d.h), screenMat);
  screen.position.set(d.x, d.y, 0.45);
  scene.add(screen);
  // Glass: reflections only (additive), strongest at a glancing angle, as on a real cover glass.
  const glass = new Mesh(new PlaneGeometry(d.w, d.h), new MeshStandardMaterial({ color: 0x000000, metalness: 0, roughness: 0.06, transparent: true, blending: AdditiveBlending, depthWrite: false, envMapIntensity: 0.1 }));
  glass.position.set(d.x, d.y, d.height - 0.25);
  scene.add(glass);

  // Stage pictures, composed onto the display at 16:10 as each one loads.
  const texW = full ? 1600 : 1024;
  const textures: Array<Promise<Texture> | undefined> = [];
  const loaded: Array<Texture | undefined> = [];
  const loadStage = (i: number): Promise<Texture> => {
    if (!textures[i]) {
      textures[i] = (async () => {
        const stage = SCENE_STAGES[i];
        const img = new Image();
        img.decoding = "async";
        img.src = stage.shot.src;
        await img.decode();
        const t = new CanvasTexture(composeStage(img, stage, texW, Math.round(texW / 1.6), fonts.mono));
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = maxAniso;
        loaded[i] = t;
        return t;
      })();
    }
    return textures[i]!;
  };

  /* State ------------------------------------------------------------------------------------------------------------------------ */
  let disposed = false;
  let raf = 0;
  let visible = true;
  let aspect = 2;
  let current = start;
  let mode: "overview" | "stage" | "reveal" = "overview";
  let drive = 0;
  let driveFrom = 0;
  let driveTo = 0;
  let driveT0 = 0;
  let driveDur = 0;
  let cam: Tween | null = null;
  let camNow: CameraStop = overviewStop(aspect);
  let wipeT0 = -1;
  let wipeDur = 650;
  let shown = -1;
  const glow = MACHINE.labels.map((_, i) => (i === current ? 1 : 0));
  const glowTo = [...glow];
  let hover = -1;
  const lampNow = { x: MACHINE.gears[current].x, y: MACHINE.gears[current].y, i: 0 };
  let lampTo = 1;
  const timers: number[] = [];
  // The lifted screen: 0 = down in its slot, 1 = upright beside the machine.
  let canLift = false;
  let lift = 0;
  let liftTween: { from: number; to: number; t0: number; dur: number; rise: boolean; done?: () => void } | null = null;
  let emptyNow = 0;
  const rect = { x: 0, y: 0, w: 1, h: 1 };

  const raised = () => canLift && (lift > 0.001 || (liftTween !== null && liftTween.to > 0));
  const stopFor = (): CameraStop =>
    mode === "reveal" ? revealStop(aspect) : mode === "stage" ? stageStop(current, aspect, tier, raised()) : overviewStop(aspect);

  const moveCamera = (to: CameraStop, dur: number, now: number) => {
    cam = { from: { position: [...camNow.position], target: [...camNow.target] }, to, t0: now, dur };
  };

  const showStage = (i: number, dur = 650) => {
    loadStage(i).then((t) => {
      if (disposed) return;
      if (i !== shown) {
        screenMat.uniforms.a.value = screenMat.uniforms.b.value;
        screenMat.uniforms.b.value = t;
        screenMat.uniforms.p.value = 0;
        wipeT0 = performance.now();
        wipeDur = dur;
        shown = i;
        kick();
      }
    }).catch(() => undefined);
  };

  /** Puts stage i's picture on the display in the plate at once (out of sight while the screen is lifted). */
  const setSlot = (i: number) => {
    loadStage(i).then((t) => {
      if (disposed) return;
      screenMat.uniforms.a.value = t;
      screenMat.uniforms.b.value = t;
      screenMat.uniforms.p.value = 1;
      wipeT0 = -1;
      shown = i;
      kick();
    }).catch(() => undefined);
  };

  const moveScreen = (to: number, dur: number, rise: boolean, done?: () => void) => {
    liftTween = { from: lift, to, t0: performance.now(), dur: ms(dur), rise, done };
    kick();
  };

  // Scratch objects for the screen's pose, reused every frame.
  const qA = new Quaternion();
  const qB = new Quaternion();
  const qT = new Quaternion();
  const basis = new Matrix4();
  const vR = new Vector3();
  const vU = new Vector3();
  const vN = new Vector3();
  const slotPose = () => {
    const centre = new Vector3(MACHINE.display.x, MACHINE.display.y, 0.45);
    basis.makeBasis(vR.set(1, 0, 0), vU.set(0, 1, 0), vN.set(0, 0, 1));
    return { centre, q: qA.setFromRotationMatrix(basis).clone(), w: MACHINE.display.w, h: MACHINE.display.h };
  };
  /** The upright screen's place in the world: its target rectangle on the canvas, unprojected to a plane facing the camera. */
  const uprightPose = () => {
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    const camPos = camera.position.clone();
    const fwd = new Vector3();
    camera.getWorldDirection(fwd);
    const depth = camPos.distanceTo(new Vector3(...camNow.target)) * 0.55;
    const at = (px: number, py: number) => {
      const dir = new Vector3((px / W) * 2 - 1, -(py / H) * 2 + 1, 0.5).unproject(camera).sub(camPos).normalize();
      return camPos.clone().addScaledVector(dir, depth / dir.dot(fwd));
    };
    const tl = at(rect.x, rect.y);
    const tr = at(rect.x + rect.w, rect.y);
    const bl = at(rect.x, rect.y + rect.h);
    const br = at(rect.x + rect.w, rect.y + rect.h);
    vR.subVectors(tr, tl).normalize();
    vU.subVectors(tl, bl).normalize();
    vN.crossVectors(vR, vU).normalize();
    basis.makeBasis(vR, vU, vN);
    const centre = tl.clone().add(tr).add(bl).add(br).multiplyScalar(0.25);
    return { centre, q: qB.setFromRotationMatrix(basis).clone(), w: tl.distanceTo(tr), h: tl.distanceTo(bl) };
  };
  /** Places the HTML screen for lift value l: down in the slot at 0, upright at 1, along a raised arc in between. */
  const placeSheet = (l: number, exact: boolean) => {
    if (l <= 0.001) {
      sheet.style.visibility = "hidden";
      return;
    }
    sheet.style.visibility = "visible";
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    let quad: Array<[number, number]>;
    if (exact) {
      quad = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]];
    } else {
      const a = slotPose();
      const b = uprightPose();
      const lift3 = a.centre.distanceTo(b.centre) * 0.05;
      const ctrl = a.centre.clone().add(b.centre).multiplyScalar(0.5).add(new Vector3(0, 0, lift3));
      const u = 1 - l;
      const centre = a.centre.clone().multiplyScalar(u * u).addScaledVector(ctrl, 2 * u * l).addScaledVector(b.centre, l * l);
      qT.slerpQuaternions(a.q, b.q, l);
      const w = lerp(a.w, b.w, l);
      const h = lerp(a.h, b.h, l);
      vR.set(1, 0, 0).applyQuaternion(qT).multiplyScalar(w / 2);
      vU.set(0, 1, 0).applyQuaternion(qT).multiplyScalar(h / 2);
      const corners = [
        centre.clone().sub(vR).add(vU), centre.clone().add(vR).add(vU), centre.clone().add(vR).sub(vU), centre.clone().sub(vR).sub(vU),
      ];
      quad = corners.map((c) => {
        const v = c.project(camera);
        return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H] as [number, number];
      });
    }
    sheet.style.transform = `matrix3d(${quadMatrix(rect.w, rect.h, quad).map((n) => (Math.abs(n) < 1e-12 ? 0 : n)).join(",")})`;
  };

  const turnTrain = (delta: number, now: number, dur: number) => {
    driveFrom = drive;
    driveTo = drive + delta;
    driveT0 = now;
    driveDur = dur;
  };

  // Easing for the smaller things (labels, lamp, parallax) runs on elapsed time, so it settles just as fast on a slow device.
  let last = 0;
  let slow = 0;
  function frame(now: number) {
    raf = 0;
    if (disposed) return;
    let busy = false;
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 1 / 60;
    const k = motion ? 1 - Math.exp(-dt / 0.12) : 1;
    // A GPU that cannot keep up gets fewer pixels: after a short run of slow frames, step the pixel ratio down (never below 1).
    if (last && now - last > 28) slow += 1; else slow = Math.max(0, slow - 1);
    if (slow > 5 && pixelRatio > 1) {
      pixelRatio = Math.max(1, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(cv.clientWidth, cv.clientHeight, false);
      slow = 0;
    }
    last = now;
    // The train.
    if (now < driveT0 + driveDur) {
      busy = true;
      drive = lerp(driveFrom, driveTo, ease(clamp01((now - driveT0) / driveDur)));
    } else drive = driveTo;
    gears.forEach((g, i) => { g.spin.rotation.z = -gearAngle(MACHINE.gears[i], drive) * DEG; });
    // The camera.
    if (cam) {
      const t = progress(now, cam.t0, cam.dur);
      const e = ease(t);
      const tw = cam;
      camNow = {
        position: [0, 1, 2].map((k) => lerp(tw.from.position[k], tw.to.position[k], e)) as CameraStop["position"],
        target: [0, 1, 2].map((k) => lerp(tw.from.target[k], tw.to.target[k], e)) as CameraStop["target"],
      };
      if (t < 1) busy = true; else cam = null;
    }
    camera.position.set(...camNow.position);
    camera.lookAt(...camNow.target);
    // The display wipe.
    if (wipeT0 >= 0) {
      const t = progress(now, wipeT0, wipeDur);
      screenMat.uniforms.p.value = ease(t);
      if (t < 1) busy = true; else wipeT0 = -1;
    }
    // Labels and the inspection lamp.
    for (let i = 0; i < glow.length; i += 1) {
      const to = Math.max(glowTo[i], i === hover ? 0.45 : 0);
      glow[i] += (to - glow[i]) * k;
      if (Math.abs(to - glow[i]) > 0.002) busy = true;
      labelMats[i].emissiveIntensity = glow[i] * 0.85;
      labelMats[i].color.setScalar(0.62 + glow[i] * 0.25);
    }
    const sel = MACHINE.gears[current];
    lampNow.x += (sel.x - lampNow.x) * k;
    lampNow.y += (sel.y - lampNow.y) * k;
    lampNow.i += (lampTo - lampNow.i) * k;
    if (Math.abs(sel.x - lampNow.x) + Math.abs(sel.y - lampNow.y) > 0.01 || Math.abs(lampTo - lampNow.i) > 0.002) busy = true;
    lamp.position.set(lampNow.x - 8, lampNow.y - 26, 95);
    lamp.target.position.set(lampNow.x, lampNow.y, 0);
    lamp.angle = Math.atan((sel.ra + 4) / 100);
    lamp.intensity = lampNow.i * 2.4;
    camera.updateMatrixWorld();
    // The lifted screen.
    let exact = false;
    if (liftTween) {
      const tw = liftTween;
      const t = progress(now, tw.t0, tw.dur);
      lift = lerp(tw.from, tw.to, tw.rise ? easeOut(t) : ease(t));
      if (t < 1) busy = true;
      else {
        lift = tw.to;
        liftTween = null;
        tw.done?.();
        if (liftTween) busy = true;
      }
    }
    if (canLift) {
      exact = lift === 1 && !liftTween;
      placeSheet(lift, exact);
      // While the screen is up its picture's slot is an empty recess; it fills again as the screen settles back in.
      const emptyTo = lift > 0.04 ? 1 : 0;
      emptyNow += (emptyTo - emptyNow) * (motion ? Math.min(1, k * 2.2) : 1);
      if (Math.abs(emptyTo - emptyNow) > 0.002) busy = true;
      screenMat.uniforms.empty.value = emptyNow;
    }
    renderer.render(scene, camera);
    if (busy && visible) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function kick() {
    if (!raf && visible && !disposed) raf = requestAnimationFrame(frame);
  }

  const startReveal = () => {
    if (disposed || current !== LAST) return;
    mode = "reveal";
    const now = performance.now();
    moveCamera(revealStop(aspect), ms(2200), now);
    lampTo = 0;
    if (!motion) {
      // Reduced motion: the whole machine and the closing message at once; nothing plays through.
      setSlot(LAST);
      lampTo = 1;
      cb.onReveal(true);
      kick();
      return;
    }
    // The whole train runs one turn of the first gear while the display steps through every stage, enquiry to invoice.
    turnTrain(360, now, 3600);
    for (let k = 0; k < SCENE_STAGES.length; k += 1) timers.push(window.setTimeout(() => showStage(k, 320), 200 + k * 420));
    timers.push(window.setTimeout(() => { lampTo = 1; cb.onReveal(true); kick(); }, 200 + SCENE_STAGES.length * 420 + 150));
    kick();
  };

  const clearTimers = () => { while (timers.length) window.clearTimeout(timers.pop()); };

  /**
   * Selecting a stage: the train turns, the lamp and label move, and the camera leans in. Where there is room, that stage's screen
   * lifts out of its slot and stands upright beside the machine (or, if a screen is already up, dips, changes and rises again).
   * On narrow screens the display in the plate wipes to the new stage instead, and reaching the invoice runs the reveal.
   */
  const select = (i: number, focus = false) => {
    const now = performance.now();
    clearTimers();
    cb.onReveal(false);
    const delta = i - current;
    const down = !raised();
    // The same stage again does nothing (this also covers the first call on mount), unless the gear or its slot was clicked.
    if (delta === 0 && !focus && mode !== "reveal") return;
    current = i;
    mode = "stage";
    lampTo = 1;
    glowTo.fill(0);
    glowTo[i] = 1;
    turnTrain(delta === 0 ? driveFor(1) / 3 : driveFor(delta), now, ms(delta === 0 ? 450 : Math.min(1100, 520 + 110 * Math.abs(delta))));
    if (canLift) {
      setSlot(i);
      // Down: the screen lifts out and stands up. Already up: it stays exactly where it is and only its picture changes.
      cb.onScreen({ stage: i, up: true });
      if (down) moveScreen(1, 620, true);
      moveCamera(stageStop(i, aspect, tier, true), ms(850), now);
    } else {
      moveCamera(stageStop(i, aspect, tier), ms(850), now);
      showStage(i, ms(420));
      if (i === LAST) timers.push(window.setTimeout(startReveal, ms(1300)));
    }
    kick();
  };

  /** Lowers the screen back into its slot; the camera eases back to show the gear and the display together. */
  const lower = (done?: () => void) => {
    if (!raised()) { done?.(); return; }
    moveScreen(0, 450, false, () => {
      cb.onScreen({ stage: current, up: false });
      done?.();
    });
    if (mode === "stage") moveCamera(stageStop(current, aspect, tier, false), ms(700), performance.now());
  };

  /** The final reveal, on request from the invoice screen: lower the screen, then run the whole machine. */
  const reveal = () => {
    clearTimers();
    lower(() => startReveal());
  };

  /* Input ------------------------------------------------------------------------------------------------------------------------ */
  const ray = new Raycaster();
  const ndc = new Vector2();
  const hit = (e: PointerEvent): number | "screen" | null => {
    const r = cv.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...pickables, screen], false);
    if (!hits.length) return null;
    const first = hits[0].object;
    return first === screen ? "screen" : (first.userData.index as number);
  };
  const fine = window.matchMedia("(pointer: fine)").matches;
  let down: { x: number; y: number } | null = null;
  // Hover only lights the label under the pointer (no camera movement); the hit test runs at most once a frame.
  let pending: PointerEvent | null = null;
  const onMove = (e: PointerEvent) => {
    if (!fine) return;
    const first = pending === null;
    pending = e;
    if (!first) return;
    requestAnimationFrame(() => {
      const ev = pending;
      pending = null;
      if (!ev || disposed) return;
      const h = hit(ev);
      const next = typeof h === "number" ? h : -1;
      cv.style.cursor = h === null ? "default" : h === "screen" && !canLift ? "zoom-in" : "pointer";
      if (next !== hover) { hover = next; kick(); }
    });
  };
  const onLeave = () => { pending = null; if (hover !== -1) { hover = -1; kick(); } cv.style.cursor = "default"; };
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { down = null; return; }
    down = null;
    const h = hit(e);
    if (h === "screen") {
      if (canLift && !raised()) select(current, true);
      else cb.onOpenFull();
    } else if (typeof h === "number") {
      if (h === current) select(h, true);
      else cb.onPick(h);
    }
  };
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerleave", onLeave);
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("pointerup", onUp);
  const onLost = (e: Event) => { e.preventDefault(); cb.onFail(); };
  cv.addEventListener("webglcontextlost", onLost);

  const resize = () => {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    aspect = w / h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    rect.x = Math.round(w * SHEET.left);
    rect.y = Math.round(h * SHEET.top);
    rect.w = Math.round(w * SHEET.width);
    rect.h = Math.round(h * SHEET.height);
    sheet.style.width = `${rect.w}px`;
    sheet.style.height = `${rect.h}px`;
    const could = canLift;
    canLift = w >= LIFT_MIN_WIDTH;
    if (could && !canLift) {
      // Too narrow now for the screen beside the machine: put it back in its slot at once.
      liftTween = null;
      lift = 0;
      emptyNow = 0;
      screenMat.uniforms.empty.value = 0;
      placeSheet(0, false);
      cb.onScreen({ stage: current, up: false });
    }
    if (!cam) camNow = stopFor();
    else cam.to = stopFor();
    kick();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(cv);
  const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) kick(); });
  io.observe(cv);

  // First picture: the whole machine, the first stage lit, its picture on the display; the other pictures load once idle.
  resize();
  camNow = overviewStop(aspect);
  shown = -1;
  glowTo.fill(0);
  glowTo[current] = 1;
  // Upload the big textures and compile every shader in the background before the first frame, so the first render is cheap.
  for (const t of [plateTex.color, plateTex.rough, turnedTex]) {
    renderer.initTexture(t);
    await step();
  }
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    // Older browsers without parallel shader compilation simply compile on the first frame.
  }
  await step();
  try {
    const t = await loadStage(current);
    if (signal.aborted) throw new Error("aborted");
    renderer.initTexture(t);
    screenMat.uniforms.a.value = t;
    screenMat.uniforms.b.value = t;
    screenMat.uniforms.p.value = 1;
    shown = current;
  } catch (e) {
    if (signal.aborted) throw e;
  }
  kick();
  requestAnimationFrame(() => { if (!disposed) cb.onReady(); });
  // The other pictures, one at a time while the page is idle, so none of them costs a visible frame.
  void (async () => {
    for (let i = 0; i < SCENE_STAGES.length; i += 1) {
      await breathe();
      if (disposed) return;
      try { renderer.initTexture(await loadStage(i)); } catch { /* the picture shows when it loads */ }
    }
  })();
  document.fonts.ready.then(() => { if (!disposed) drawLabels(); }).catch(() => drawLabels());

  return {
    select,
    lower: () => lower(),
    reveal,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimers();
      ro.disconnect();
      io.disconnect();
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerleave", onLeave);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("webglcontextlost", onLost);
      const mats = new Set<Material>();
      scene.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          for (const mat of Array.isArray(o.material) ? o.material : [o.material]) mats.add(mat);
        }
      });
      mats.forEach((mat) => mat.dispose());
      for (const t of [turnedTex, grain, radial, plateTex.color, plateTex.rough, blank, env, ...loaded, ...labelMats.map((l) => l.map)]) t?.dispose();
      room.traverse((o) => { if (o instanceof Mesh) { o.geometry.dispose(); (o.material as Material).dispose(); } });
      pmrem.dispose();
      renderer.dispose();
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* React                                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export default function GearWorkflow3D({ active, tier, motion, onPick, onOpenFull, onRestart, onFail }: GearWorkflow3DProps) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const sheet = useRef<HTMLElement | null>(null);
  const engine = useRef<Awaited<ReturnType<typeof createEngine>> | null>(null);
  const cbs = useRef({ onPick, onOpenFull, onFail });
  cbs.current = { onPick, onOpenFull, onFail };
  const latest = useRef(active);
  latest.current = active;
  const [ready, setReady] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [touch, setTouch] = useState(false);
  const [screen, setScreen] = useState({ stage: active, up: false });

  useEffect(() => {
    const node = cv.current;
    const sheetNode = sheet.current;
    if (!node || !sheetNode) return;
    setTouch(!window.matchMedia("(pointer: fine)").matches);
    const signal = { aborted: false };
    const start = latest.current;
    createEngine(node, sheetNode, tier, start, motion, {
      onPick: (i) => cbs.current.onPick(i),
      onOpenFull: () => cbs.current.onOpenFull(),
      onFail: () => cbs.current.onFail(),
      onReady: () => setReady(true),
      onReveal: setRevealed,
      onScreen: setScreen,
    }, signal).then((e) => {
      if (signal.aborted) { e.dispose(); return; }
      engine.current = e;
      // Anything chosen while the scene was being built.
      if (latest.current !== start) e.select(latest.current);
    }).catch(() => {
      if (!signal.aborted) cbs.current.onFail();
    });
    return () => {
      signal.aborted = true;
      engine.current?.dispose();
      engine.current = null;
    };
  }, [tier, motion]);

  useEffect(() => {
    engine.current?.select(active);
  }, [active]);

  const stage = SCENE_STAGES[active];
  const shown = SCENE_STAGES[screen.stage];
  const prev = screen.stage > 0 ? SCENE_STAGES[screen.stage - 1] : null;
  const next = screen.stage < LAST ? SCENE_STAGES[screen.stage + 1] : null;
  return (
    <div className="gw3" data-ready={ready ? "" : undefined} data-up={screen.up ? "" : undefined}>
      <canvas ref={cv} className="gw3-canvas" aria-hidden="true" />
      <div className="gw3-foot">
        <span className="mk-label gw3-hint" aria-hidden="true">{touch ? SCENE_COPY.hintTouch : SCENE_COPY.hintPointer}</span>
        <span className="gw3-shot">
          <span className="mk-label">Op {stage.op} · {stage.shot.source} · {GEAR_COPY.shotNote}</span>
          <button type="button" className="gw3-link" onClick={onOpenFull}>{GEAR_COPY.fullSize}</button>
        </span>
      </div>

      {/* The screen that lifts out of the plate. Its position and perspective are set by the engine; when it is down in its slot it is
          hidden and inert. Upright it shows a cropped view of the stage's picture (the whole picture is one click away), with arrows to
          the stage before and after. */}
      <section ref={sheet} className="gw3-sheet" aria-label={`${shown.label} in Tolra`} aria-hidden={!screen.up} inert={!screen.up}>
        <div className="gw3-sheet-bar">
          <span className="gw3-sheet-dot" aria-hidden="true" />
          <span className="mk-mono">Tolra · {shown.shot.source}</span>
          <button type="button" className="gw3-sheet-close" aria-label={SCENE_COPY.lower} title={SCENE_COPY.lower} onClick={() => engine.current?.lower()}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </div>
        <button type="button" className={`gw3-sheet-body gw3-sheet-${shown.shot.kind}`} onClick={onOpenFull} aria-label={`${GEAR_COPY.fullSize}: ${shown.shot.source}`}>
          <NextImage key={shown.id} className="gw3-sheet-img" src={shown.shot.src} width={shown.shot.width} height={shown.shot.height} alt={shown.shot.alt} sizes="(min-width: 1240px) 640px, 55vw" />
        </button>
        <div className="gw3-sheet-foot">
          {prev ? (
            <button type="button" className="gw3-sheet-btn gw3-sheet-prev" onClick={() => onPick(screen.stage - 1)} aria-label={`${SCENE_COPY.previous}: ${prev.label}`}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="gw3-sheet-name">{prev.label}</span>
            </button>
          ) : <span />}
          <span className="mk-label gw3-sheet-op">Op {shown.op} · {GEAR_COPY.shotNote}</span>
          {next ? (
            <button type="button" className="gw3-sheet-btn gw3-sheet-next" onClick={() => onPick(screen.stage + 1)} aria-label={`${SCENE_COPY.next}: ${next.label}`}>
              <span className="gw3-sheet-name">{next.label}</span>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          ) : (
            <button type="button" className="gw3-sheet-btn gw3-sheet-next" onClick={() => engine.current?.reveal()}>
              <span className="gw3-sheet-name">{SCENE_COPY.runAll}</span>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>
      </section>

      {revealed ? (
        <div className="gw3-reveal">
          <div>
            <p className="mk-label">{SCENE_COPY.revealKicker}</p>
            <p className="mk-display gw3-reveal-title">{SCENE_COPY.revealTitle}</p>
          </div>
          <div className="gw3-reveal-actions">
            <Cta />
            <button type="button" className="gw3-restart" onClick={onRestart}>{SCENE_COPY.restart}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
