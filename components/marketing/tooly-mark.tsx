"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { TOOLY_POSES, type ToolyPose } from "@/components/tooly/poses";

// Inputs: an optional `pose` (the parent decides) or nothing (ambient mode: Tooly idles, blinks now and then, waves when first seen and
// falls asleep when nobody has touched the page for a while). Output: Tooly built from the app's pose stills (components/tooly/poses.ts),
// swapped instantly and nudged with transform and opacity only. All the poses an instance can show are stacked in the same box, so a swap
// never loads, resizes or shifts anything.
// Must not change: it is decorative (the box is aria-hidden, so the image alt text is never read) unless `label` is given (then it has that alt text); it never takes focus or pointer events; it is
// fully static under prefers-reduced-motion; it pauses when off screen or in a hidden tab. Does not edit the app's ToolyFace.

const AMBIENT_POSES: readonly ToolyPose[] = ["idle", "blink", "wave", "sleep"];
const WAVE_MS = 1800;
const BLINK_MS = 150;

type Props = {
  /** Controlled mode: show this pose. Leave out for the ambient loop. */
  pose?: ToolyPose;
  /** Poses the instance may show (controlled mode: list the ones the parent will switch between), so they are all in place up front. */
  poses?: readonly ToolyPose[];
  size: number;
  /** Ambient mode: wave once the first time it comes into view. */
  waveOnView?: boolean;
  /** Ambient mode: fall asleep after this long without a pointer, key or scroll on the page. 0 = never. */
  sleepAfterMs?: number;
  /** Alt text when Tooly carries meaning. Left out, he is decorative and hidden from assistive tech. */
  label?: string;
  /** Load the images straight away (above the fold). */
  eager?: boolean;
  className?: string;
};

export function ToolyMark({ pose, poses, size, waveOnView = true, sleepAfterMs = 22000, label, eager = false, className = "" }: Props) {
  const controlled = pose !== undefined;
  const [ambient, setAmbient] = useState<ToolyPose>("idle");
  const [beat, setBeat] = useState(0);
  const [live, setLive] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const [blinking, setBlinking] = useState(false);
  const base = controlled ? pose : ambient;
  const current: ToolyPose = blinking && base === "idle" ? "blink" : base;
  const stack = Array.from(new Set<ToolyPose>(controlled ? [...(poses ?? []), pose, "blink"] : [...AMBIENT_POSES, ...(poses ?? [])]));

  // A small "pop" whenever the pose changes to something other than a blink (CSS plays it; two names so it restarts each time).
  useEffect(() => { if (current !== "blink" && current !== "idle") setBeat((n) => n + 1); }, [current]);

  // `live`: on screen, tab visible, and the person has not asked for reduced motion. Nothing runs otherwise.
  useEffect(() => {
    const node = root.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const update = () => setLive(visible && !document.hidden && !motion.matches);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); update(); });
    if (observer && node) observer.observe(node); else { visible = true; update(); }
    document.addEventListener("visibilitychange", update);
    motion.addEventListener("change", update);
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); motion.removeEventListener("change", update); };
  }, []);

  // Ambient behaviour, only while live.
  const waved = useRef(false);
  useEffect(() => {
    if (controlled || !live) return;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => { const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    let asleep = false;
    let sleepTimer = 0;
    const armSleep = () => {
      window.clearTimeout(sleepTimer);
      if (sleepAfterMs > 0) sleepTimer = window.setTimeout(() => { asleep = true; setAmbient("sleep"); }, sleepAfterMs);
    };
    const wake = () => {
      if (asleep) { asleep = false; setAmbient("idle"); }
      armSleep();
    };
    if (waveOnView && !waved.current) {
      waved.current = true;
      setAmbient("wave");
      later(() => setAmbient((p) => (p === "wave" ? "idle" : p)), WAVE_MS);
    }
    armSleep();
    const events = ["pointermove", "keydown", "scroll", "touchstart"] as const;
    events.forEach((name) => window.addEventListener(name, wake, { passive: true }));
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      window.clearTimeout(sleepTimer);
      events.forEach((name) => window.removeEventListener(name, wake));
    };
  }, [controlled, live, waveOnView, sleepAfterMs]);

  // The occasional blink, in either mode, only while live and only while the pose is the idle one.
  useEffect(() => {
    if (!live) return;
    let id = 0;
    const loop = () => {
      id = window.setTimeout(() => {
        setBlinking(true);
        id = window.setTimeout(() => { setBlinking(false); loop(); }, BLINK_MS);
      }, 3200 + Math.random() * 2800);
    };
    loop();
    return () => { window.clearTimeout(id); setBlinking(false); };
  }, [live]);

  const decorative = !label;
  return (
    <div
      ref={root}
      className={`mk-tooly ${className}`}
      style={{ width: size, height: size }}
      data-live={live}
      data-pose={current}
      data-beat={beat % 2 === 0 ? "a" : "b"}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
    >
      <div className="mk-tooly-body">
        {stack.map((name) => (
          <Image
            key={name}
            src={TOOLY_POSES[name]}
            alt="Tooly, the AI helper's mascot"
            width={size}
            height={size}
            sizes={`${size}px`}
            loading={eager ? "eager" : "lazy"}
            draggable={false}
            className="mk-tooly-pose"
            style={{ opacity: name === current ? 1 : 0 }}
          />
        ))}
      </div>
    </div>
  );
}
