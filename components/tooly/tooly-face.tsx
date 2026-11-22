"use client";

import { TOOLY_POSES, type ToolyPose } from "@/components/tooly/poses";

/**
 * Tooly is the AI helper's face. No separate toggle: visibility is controlled by the AI UI that mounts this.
 */
export function ToolyFace({
  pose = "idle",
  size = 96,
  label = "Tooly",
}: {
  pose?: ToolyPose;
  size?: number;
  label?: string;
}) {
  return (
    <img
      src={TOOLY_POSES[pose]}
      alt={label}
      width={size}
      height={size}
      className="object-contain"
      data-testid="tooly-face"
      data-pose={pose}
    />
  );
}
