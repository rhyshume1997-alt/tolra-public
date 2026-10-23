import type { Instrumentation } from "next";

/**
 * Every unhandled error in a page, route handler or server action reaches here (Next's onRequestError). In production with
 * ALERT_EMAIL_TO set, it is reported by e-mail, sanitised and rate limited (lib/server/error-alert.ts). Only the path of the
 * request is passed on: no headers, body or cookies.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportServerError } = await import("@/lib/server/error-alert");
  await reportServerError({ route: `${request.method} ${request.path}`, error, source: "server" });
};
