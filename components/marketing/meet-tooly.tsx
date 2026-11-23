"use client";

import { useEffect, useRef, useState } from "react";

import { FeatureFigure } from "@/components/marketing/feature-figure";
import { ToolyMark } from "@/components/marketing/tooly-mark";
import type { ToolyPose } from "@/components/tooly/poses";
import { FEATURES, ILLUSTRATION_LABEL, TOOLY_DEMO, TOOLY_INTRO, TOOLY_POINTS, TOOLY_TITLE } from "@/lib/marketing";

// Inputs: the copy in lib/marketing.ts (TOOLY_*) and the optional-AI-helper feature (its drawn draft quote).
// Output: the "Meet Tooly" section: what the helper does and its status, and a small working demo where Tooly reads an example enquiry
// (thinks), shows the draft flagged for review (points) and celebrates when the example is approved as a draft. He sleeps if the demo
// sits untouched for a while.
// Must not change: no network call, nothing stored; the example values match the traveller's; the claims stay those in TOOLY_*; the
// draft figure keeps its Illustration label; the controls are real buttons and the status is a polite live region; no motion for
// reduced motion (ToolyMark handles it); the demo's timer only runs while the person has pressed the button.

type Step = "idle" | "reading" | "review" | "done";
const READ_MS = 1600;
const DEMO_POSES: readonly ToolyPose[] = ["idle", "think", "point", "celebrate", "sleep"];
const POSE: Record<Step, ToolyPose> = { idle: "idle", reading: "think", review: "point", done: "celebrate" };
const IDLE_SLEEP_MS = 25000;

export function MeetTooly() {
  const [step, setStep] = useState<Step>("idle");
  const [asleep, setAsleep] = useState(false);
  const timer = useRef(0);
  const draft = FEATURES.find((f) => f.figure.kind === "draft")!;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Untouched for a while at the start: Tooly dozes. Any press, key or pointer move on the page wakes him.
  useEffect(() => {
    if (step !== "idle") { setAsleep(false); return; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let id = window.setTimeout(() => setAsleep(true), IDLE_SLEEP_MS);
    const wake = () => { setAsleep(false); window.clearTimeout(id); id = window.setTimeout(() => setAsleep(true), IDLE_SLEEP_MS); };
    const names = ["pointermove", "keydown", "scroll"] as const;
    names.forEach((n) => window.addEventListener(n, wake, { passive: true }));
    return () => { window.clearTimeout(id); names.forEach((n) => window.removeEventListener(n, wake)); };
  }, [step]);

  function start() {
    setStep("reading");
    window.clearTimeout(timer.current);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = window.setTimeout(() => setStep("review"), reduce ? 300 : READ_MS);
  }

  const pose: ToolyPose = step === "idle" && asleep ? "sleep" : POSE[step];
  return (
    <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
      <div className="lg:col-span-5">
        <ToolyMark pose={pose} poses={DEMO_POSES} size={280} className="!h-[200px] !w-[200px] sm:!h-[260px] sm:!w-[260px] lg:!h-[280px] lg:!w-[280px]" />
        <p className="mk-label mt-2">{draft.title}</p>
        <h2 id="tooly-title" className="mk-display mt-2 text-[clamp(2.25rem,4.4vw,3.5rem)] uppercase">{TOOLY_TITLE}</h2>
        <p className="mt-4 max-w-[40ch] text-lg leading-relaxed text-[#3c5277]">{TOOLY_INTRO}</p>
        <p className="mt-3 max-w-[40ch] text-[#3c5277]">{draft.detail}</p>
      </div>

      <div className="lg:col-span-7">
        <div role="group" aria-labelledby="tooly-demo-title" className="border border-[#0b2a5b] bg-white">
          <div className="flex items-start justify-between gap-4 border-b border-[#0b2a5b] px-[var(--mk-box)] py-[var(--mk-box-y)]">
            <p id="tooly-demo-title" className="mk-display text-[1.5rem] uppercase">{TOOLY_DEMO.label}</p>
            <p className="mk-label shrink-0 pt-1">{ILLUSTRATION_LABEL}</p>
          </div>
          <div className="grid gap-4 p-[var(--mk-box)]">
            <div>
              <p className="mk-label">{TOOLY_DEMO.enquiryTitle}</p>
              <p className="mt-1.5 border border-[#0b2a5b]/40 bg-[#fbfcfd] p-3 text-[0.9375rem] leading-relaxed">{TOOLY_DEMO.enquiry}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {step === "idle" ? <button type="button" onClick={start} className="mk-cta">{TOOLY_DEMO.start}</button> : null}
              {step === "reading" ? <button type="button" disabled className="mk-cta">{TOOLY_DEMO.start}</button> : null}
              {step === "review" ? <button type="button" onClick={() => setStep("done")} className="mk-cta">{TOOLY_DEMO.approve}</button> : null}
              {step === "done" ? <button type="button" onClick={() => setStep("idle")} className="mk-cta">{TOOLY_DEMO.again}</button> : null}
            </div>
            <p role="status" aria-live="polite" className="min-h-[3.25rem] border-t border-dashed border-[#0b2a5b]/40 pt-3 text-[0.9375rem] sm:min-h-[1.75rem]">
              {TOOLY_DEMO.status[step]}
            </p>
          </div>
        </div>
        <div className="mt-6">
          <FeatureFigure figure={draft.figure} shot={draft.shot} />
        </div>
        <p className="mk-label mt-3">{TOOLY_DEMO.note}</p>
      </div>

      <ol className="grid gap-x-10 gap-y-8 border-t border-[#0b2a5b] pt-8 sm:grid-cols-2 lg:col-span-12 lg:grid-cols-4 lg:gap-x-8">
        {TOOLY_POINTS.map((point) => (
          <li key={point.title}>
            <h3 className="mk-display text-[1.625rem]">{point.title}</h3>
            <p className="mt-2 text-[#3c5277]">{point.detail}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
