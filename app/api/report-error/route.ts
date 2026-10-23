import { NextResponse } from "next/server";
import { z } from "zod";

import { forbiddenOrigin, isErrorResponse, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";
import { reportServerError } from "@/lib/server/error-alert";

// The browser's error screens (app/global-error.tsx, app/error.tsx, the dashboard's) report a crash here. Only a signed-in
// person can: anyone could otherwise use up the day's alert budget. The body is a message, an optional Next digest and the
// page's path; all of it is redacted before anything is sent, and the answer never says whether an e-mail went.
const schema = z.object({
  message: z.string().max(2000).default(""),
  digest: z.string().max(64).optional(),
  path: z.string().max(300).optional(),
});

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile();
  if (isErrorResponse(auth)) return auth;
  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return NextResponse.json({ ok: true });
  const { message, digest, path } = parsed.data;
  await reportServerError({ route: `PAGE ${path ?? "unknown"}`, error: digest ? `${message} (digest ${digest})` : message, source: "browser" });
  return NextResponse.json({ ok: true });
}
