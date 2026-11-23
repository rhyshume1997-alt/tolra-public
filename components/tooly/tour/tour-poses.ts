/**
 * BOUNDARY (Tooly, game-style tour): which of Tooly's existing poses goes with a step. Pure data and one function.
 * Inputs: a step id and whether the step points at something on the page. Outputs: a ToolyPose from components/tooly/poses.ts
 * (images already in public/tooly; none are added). Must not change: the pose names (they are the image set).
 */
import type { ToolyPose } from "@/components/tooly/poses";

const BY_ID: Readonly<Record<string, ToolyPose>> = { hello: "wave", done: "celebrate" };

/** wave on the hello step, celebrate on the last, point when there is something to look at, think when the step only talks. */
export function poseForStep(id: string, hasTarget: boolean): ToolyPose {
  return BY_ID[id] ?? (hasTarget ? "point" : "think");
}
