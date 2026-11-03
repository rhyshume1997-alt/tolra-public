import { z } from "zod";

import { headerText } from "@/lib/mail-header";
import { sendMail } from "@/lib/m365/graph";
import { mailGuard, mailKey, recipientAllowed, sendAndLog } from "@/lib/m365/route";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";

const schema = z.object({
  to: z.string().trim().toLowerCase().email().max(254),
  // One line: CR / LF and other control characters never reach the subject header.
  subject: z.string().transform(headerText).pipe(z.string().min(1).max(200)),
  body: z.string().trim().min(1).max(10000),
});

/** New message from the connected mailbox (kept in its Sent Items). */
export async function POST(request: Request) {
  const ctx = await mailGuard(request);
  if (isErrorResponse(ctx)) return ctx;

  const json = await readJson(request, 32 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { to, subject, body } = parsed.data;
  if (!(await recipientAllowed(ctx.auth, to))) return jsonError("Recipient not allowed", 403);

  return sendAndLog(
    ctx,
    request,
    "mail/send",
    { kind: "send", key: mailKey("send", [to], subject, body), recipients: [to], subject, body },
    () => sendMail({ to, subject, body }, ctx.config),
  );
}
