/** Tooly pose image paths under public/tooly/. Only imported by ToolyFace. Same-origin; CSP already allows 'self'. */
export type ToolyPose = "idle" | "blink" | "wave" | "think" | "celebrate" | "oops" | "sleep" | "point" | "love";

export const TOOLY_POSES: Record<ToolyPose, string> = {
  idle: "/tooly/idle.webp",
  blink: "/tooly/blink.webp",
  wave: "/tooly/wave.webp",
  think: "/tooly/think.webp",
  celebrate: "/tooly/celebrate.webp",
  oops: "/tooly/oops.webp",
  sleep: "/tooly/sleep.webp",
  point: "/tooly/point.webp",
  love: "/tooly/love.webp",
};
