"use client";

/*
 * "The Tolra Machine" in 3D (version B of the home page gear workflow, shown with ?gears=3d): seven machined steel gears on an
 * anodised plate, arched over a display set into the plate. Selecting a stage turns the train (true involute teeth, opposite
 * directions, inverse ratios), lights that gear, leans the camera in towards it and wipes the display over to that stage's image.
 * Reaching the invoice runs the whole train once while the display steps through every stage, then pulls back and offers the
 * booking link.
 *
 * Inputs: the stage index chosen in GearWorkflow (the stage chips, Previous / Next and the gears themselves all go through its
 * pick), the render tier, and callbacks. Geometry, camera stops and words come from lib/marketing/gear-scene.ts; stage copy and
 * images from lib/marketing/gear-workflow.ts. Output: one canvas (hidden from assistive technology: the chips are the accessible
 * control) with a few labels over it. No data, no network beyond the stage images already in public/marketing/workflow/.
 * Must not change: it is only ever loaded on demand by components/marketing/gear-workflow.tsx, never server rendered, renders only
 * while something moves, and hands back to the 2D drawing if WebGL fails.
 */
import { useEffect, useRef, useState } from "react";
import {
  AdditiveBlending, BackSide, BoxGeometry, CanvasTexture, CylinderGeometry, DirectionalLight, ExtrudeGeometry, Group, LatheGeometry, Mesh, MeshBasicMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, NeutralToneMapping, NoColorSpace, Object3D, PCFShadowMap, PerspectiveCamera, Path, PlaneGeometry,
  PMREMGenerator, Raycaster, RepeatWrapping, Scene, ShaderMaterial, Shape, SpotLight, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
  type BufferGeometry, type Material, type Texture,
} from "three";

import { Cta } from "@/components/marketing/cta";
import {
  FOV, MACHINE, SCENE_COPY, overviewStop, revealStop, stageStop, toothOutline, type CameraStop, type RenderTier, type SceneGear,
} from "@/lib/marketing/gear-scene";
import { GEAR_COPY, GEAR_STAGES, STAGE_COUNT, VERSION_COPY, driveFor, gearAngle, type GearStage } from "@/lib/marketing/gear-workflow";

type Tier = Exclude<RenderTier, "none">;

export type GearWorkflow3DProps = {
  active: number;
  tier: Tier;
  onPick: (index: number) => void;
  onOpenFull: () => void;
  onRestart: () => void;
  /** WebGL could not start or was lost: the caller goes back to the 2D drawing. */
  onFail: () => void;
};

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
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
function composeStage(img: HTMLImageElement, stage: GearStage, W: number, H: number, mono: string): HTMLCanvasElement {
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
    // Wide app screens would be tiny shown whole at 16:10: show them larger, from the left (where each screen starts), and crop
    // the rest; the full image is one click away.
    const m = W * 0.035;
    const aw = W - 2 * m;
    const ah = H - bar - 2 * m;
    const s = Math.min(ah / img.naturalHeight, (aw / img.naturalWidth) * 1.75);
    const iw = img.naturalWidth * s;
    const ih = img.naturalHeight * s;
    const top = bar + m + (ah - ih) / 2;
    x.save();
    x.shadowColor = "rgba(12,22,38,0.2)";
    x.shadowBlur = W * 0.012;
    x.fillStyle = "#fff";
    x.fillRect(m, top, Math.min(iw, aw), ih);
    x.restore();
    x.save();
    x.beginPath();
    x.rect(m, top, aw, ih);
    x.clip();
    x.drawImage(img, m, top, iw, ih);
    x.restore();
    if (iw > aw) {
      const fade = x.createLinearGradient(W - m - W * 0.08, 0, W - m, 0);
      fade.addColorStop(0, "rgba(231,235,241,0)");
      fade.addColorStop(1, "rgba(231,235,241,1)");
      x.fillStyle = fade;
      x.fillRect(W - m - W * 0.08, top, W * 0.08, ih);
    }
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

type Callbacks = { onPick: (i: number) => void; onOpenFull: () => void; onReady: () => void; onFail: () => void; onReveal: (on: boolean) => void };

type Tween = { from: CameraStop; to: CameraStop; t0: number; dur: number };

function createEngine(cv: HTMLCanvasElement, tier: Tier, start: number, cb: Callbacks) {
  const full = tier === "full";
  const renderer = new WebGLRenderer({ canvas: cv, antialias: true, alpha: true, powerPreference: full ? "high-performance" : "default" });
  let pixelRatio = Math.min(window.devicePixelRatio || 1, full ? 2 : 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = full;
  renderer.shadowMap.type = PCFShadowMap;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
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
    key.shadow.mapSize.set(2048, 2048);
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
  const turnedTex = turnedTexture(full ? 1024 : 512);
  const grain = grainTexture(256);
  grain.wrapS = grain.wrapT = RepeatWrapping;
  grain.repeat.set(6, 6);
  const plateTex = plateTextures(full ? 2048 : 1024);
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
  const gears = MACHINE.gears.map((g) => buildGear(g, m, full));
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
    uniforms: { a: { value: blank }, b: { value: blank }, p: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
      uniform sampler2D a; uniform sampler2D b; uniform float p; varying vec2 vUv;
      void main() {
        float edge = 1.0 - p;
        vec3 c = mix(texture2D(a, vUv).rgb, texture2D(b, vUv).rgb, smoothstep(edge - 0.003, edge + 0.003, vUv.y));
        float line = (1.0 - smoothstep(0.0, 0.012, abs(vUv.y - edge))) * step(0.001, p) * step(p, 0.999);
        c = mix(c, vec3(0.62, 0.74, 1.0), line * 0.5);
        vec2 q = vUv - 0.5;
        c *= 1.0 - 0.16 * dot(q, q);
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
  const texW = full ? 2048 : 1280;
  const textures: Array<Promise<Texture> | undefined> = [];
  const loaded: Array<Texture | undefined> = [];
  const loadStage = (i: number): Promise<Texture> => {
    if (!textures[i]) {
      textures[i] = (async () => {
        const stage = GEAR_STAGES[i];
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
  const par = { x: 0, y: 0, tx: 0, ty: 0 };
  const lampNow = { x: MACHINE.gears[current].x, y: MACHINE.gears[current].y, i: 0 };
  let lampTo = 1;
  const timers: number[] = [];

  const stopFor = (): CameraStop => (mode === "reveal" ? revealStop(aspect) : mode === "stage" ? stageStop(current, aspect, tier) : overviewStop(aspect));

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
    const k = 1 - Math.exp(-dt / 0.12);
    // A GPU that cannot keep up gets fewer pixels: after a run of slow frames, step the pixel ratio down (never below 1).
    if (last && now - last > 45) slow += 1; else slow = Math.max(0, slow - 1);
    if (slow > 10 && pixelRatio > 1) {
      pixelRatio = Math.max(1, pixelRatio - 0.5);
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
      const t = clamp01((now - cam.t0) / cam.dur);
      const e = ease(t);
      const tw = cam;
      camNow = {
        position: [0, 1, 2].map((k) => lerp(tw.from.position[k], tw.to.position[k], e)) as CameraStop["position"],
        target: [0, 1, 2].map((k) => lerp(tw.from.target[k], tw.to.target[k], e)) as CameraStop["target"],
      };
      if (t < 1) busy = true; else cam = null;
    }
    // Pointer parallax (full tier only): a slight shift of viewpoint, so the depth reads.
    par.x += (par.tx - par.x) * k * 0.7;
    par.y += (par.ty - par.y) * k * 0.7;
    if (Math.abs(par.tx - par.x) > 0.001 || Math.abs(par.ty - par.y) > 0.001) busy = true;
    const p = new Vector3(...camNow.position);
    const target = new Vector3(...camNow.target);
    const dist = p.distanceTo(target);
    const fwd = target.clone().sub(p).normalize();
    const right = new Vector3().crossVectors(fwd, new Vector3(0, 0, 1)).normalize();
    const up = new Vector3().crossVectors(right, fwd);
    p.addScaledVector(right, par.x * dist * 0.035).addScaledVector(up, par.y * dist * 0.025);
    camera.position.copy(p);
    camera.lookAt(target);
    // The display wipe.
    if (wipeT0 >= 0) {
      const t = clamp01((now - wipeT0) / wipeDur);
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
    renderer.render(scene, camera);
    if (busy && visible) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function kick() {
    if (!raf && visible && !disposed) raf = requestAnimationFrame(frame);
  }

  const startReveal = () => {
    if (disposed || current !== STAGE_COUNT - 1) return;
    mode = "reveal";
    const now = performance.now();
    moveCamera(revealStop(aspect), 2600, now);
    // The whole train runs one turn of the first gear while the display steps through every stage, enquiry to invoice.
    turnTrain(360, now, 3800);
    lampTo = 0;
    for (let k = 0; k < STAGE_COUNT; k += 1) timers.push(window.setTimeout(() => showStage(k, 360), 250 + k * 470));
    timers.push(window.setTimeout(() => { lampTo = 1; cb.onReveal(true); kick(); }, 250 + STAGE_COUNT * 470 + 200));
    kick();
  };

  const clearTimers = () => { while (timers.length) window.clearTimeout(timers.pop()); };

  /** Selecting a stage: the train turns, the camera leans in, the lamp and label move, and the display wipes to the new stage. */
  const select = (i: number, focus = false) => {
    const now = performance.now();
    clearTimers();
    cb.onReveal(false);
    const delta = i - current;
    if (delta === 0 && !focus && mode !== "reveal") return;
    current = i;
    mode = "stage";
    lampTo = 1;
    glowTo.fill(0);
    glowTo[i] = 1;
    turnTrain(delta === 0 ? driveFor(1) / 3 : driveFor(delta), now, delta === 0 ? 700 : Math.min(1700, 800 + 160 * Math.abs(delta)));
    moveCamera(stageStop(i, aspect, tier), 1350, now);
    showStage(i);
    if (i === STAGE_COUNT - 1) timers.push(window.setTimeout(startReveal, 1700));
    kick();
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
  const onMove = (e: PointerEvent) => {
    if (full && fine) {
      const r = cv.getBoundingClientRect();
      par.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      par.ty = -((e.clientY - r.top) / r.height - 0.5) * 2;
    }
    if (fine) {
      const h = hit(e);
      const next = typeof h === "number" ? h : -1;
      cv.style.cursor = h === null ? "default" : h === "screen" ? "zoom-in" : "pointer";
      if (next !== hover) hover = next;
    }
    kick();
  };
  const onLeave = () => { par.tx = 0; par.ty = 0; hover = -1; cv.style.cursor = "default"; kick(); };
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { down = null; return; }
    down = null;
    const h = hit(e);
    if (h === "screen") cb.onOpenFull();
    else if (typeof h === "number") {
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
  loadStage(current).then((t) => {
    if (disposed) return;
    screenMat.uniforms.a.value = t;
    screenMat.uniforms.b.value = t;
    screenMat.uniforms.p.value = 1;
    shown = current;
    kick();
    requestAnimationFrame(() => { if (!disposed) cb.onReady(); });
    const rest = () => GEAR_STAGES.forEach((_, i) => { void loadStage(i).catch(() => undefined); });
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(rest); else globalThis.setTimeout(rest, 800);
  }).catch(() => cb.onReady());
  document.fonts.ready.then(() => { if (!disposed) drawLabels(); }).catch(() => drawLabels());
  kick();

  return {
    select,
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

export default function GearWorkflow3D({ active, tier, onPick, onOpenFull, onRestart, onFail }: GearWorkflow3DProps) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const engine = useRef<ReturnType<typeof createEngine> | null>(null);
  const cbs = useRef({ onPick, onOpenFull, onFail });
  cbs.current = { onPick, onOpenFull, onFail };
  const first = useRef(active);
  first.current = active;
  const [ready, setReady] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    const node = cv.current;
    if (!node) return;
    setTouch(!window.matchMedia("(pointer: fine)").matches);
    try {
      engine.current = createEngine(node, tier, first.current, {
        onPick: (i) => cbs.current.onPick(i),
        onOpenFull: () => cbs.current.onOpenFull(),
        onFail: () => cbs.current.onFail(),
        onReady: () => setReady(true),
        onReveal: setRevealed,
      });
    } catch {
      cbs.current.onFail();
    }
    return () => {
      engine.current?.dispose();
      engine.current = null;
    };
  }, [tier]);

  useEffect(() => {
    engine.current?.select(active);
  }, [active]);

  const stage = GEAR_STAGES[active];
  return (
    <div className="gw3" data-ready={ready ? "" : undefined}>
      <canvas ref={cv} className="gw3-canvas" aria-hidden="true" />
      <div className="gw3-head" aria-hidden="true">
        <span className="mk-label">{SCENE_COPY.head}</span>
        <span className="mk-label">{SCENE_COPY.note}</span>
      </div>
      {ready ? null : <p className="gw3-load mk-label">{VERSION_COPY.loading}</p>}
      <div className="gw3-foot">
        <span className="mk-label gw3-hint" aria-hidden="true">{touch ? SCENE_COPY.hintTouch : SCENE_COPY.hintPointer}</span>
        <span className="gw3-shot">
          <span className="mk-label">Op {stage.op} · {stage.shot.source} · {GEAR_COPY.shotNote}</span>
          <button type="button" className="gw3-link" onClick={onOpenFull}>{GEAR_COPY.fullSize}</button>
        </span>
      </div>
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
