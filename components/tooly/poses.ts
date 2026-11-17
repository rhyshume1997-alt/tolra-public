/** Tooly poses as data URLs. Only imported by ToolyFace — keeps the rest of the app free of this weight. */
import { idle } from "./pose-idle";
import { blink } from "./pose-blink";
import { wave } from "./pose-wave";
import { think } from "./pose-think";
import { celebrate } from "./pose-celebrate";
import { oops } from "./pose-oops";
import { sleep } from "./pose-sleep";
import { point } from "./pose-point";
import { love } from "./pose-love";

export type ToolyPose = "idle" | "blink" | "wave" | "think" | "celebrate" | "oops" | "sleep" | "point" | "love";

export const TOOLY_POSES: Record<ToolyPose, string> = {
  idle,
  blink,
  wave,
  think,
  celebrate,
  oops,
  sleep,
  point,
  love,
};
