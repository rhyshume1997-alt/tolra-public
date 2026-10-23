import { z } from "zod";

import { forwardMessage } from "@/lib/m365/graph";
import { allRecipientsAllowed, mailGuard, mailKey, sendAndLog } from "@/lib/m365/route";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";

const schema = z.object({
  inboundEmailId: z.string().uuid(),
  to: z.string().trim().toLowerCase().email().max(254),
  comment: z.string().trim().max(10000).default(""),
});

/** Forwards a stored inbound message, from the connected mailbox. */
export async function POST(request: Request) {
  const ctx = await mailGuard(request);
  if (isErrorResponse(ctx)) return ctx;

  const json = await readJson(request, 32 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { inboundEmailId, to, comment } = parsed.data;
  const recipients = [to];
  if (!(await allRecipientsAllowed(ctx.auth, recipients))) return jsonError("Recipient not allowed", 403);

  const { data: mail } = await ctx.auth.supabase
    .from("inbound_emails")
    .select("graph_message_id, subject, rfq_id")
    .eq("id", inboundEmailId)
    .eq("organization_id", ctx.auth.profile.organization_id)
    .maybeSingle();
  if (!mail) return jsonError("Message not found", 404);

  const subject = `Fwd: ${mail.subject ?? ""}`.trim().slice(0, 200);
  const body = comment || "(forwarded without a note)";
  return sendAndLog(
    ctx,
    request,
    "mail/forward",
    { kind: "forward", key: mailKey("forward", [inboundEmailId, ...recipients], subject, body), recipients, subject, body, rfqId: mail.rfq_id },
    () => forwardMessage(mail.graph_message_id, recipients, comment, ctx.config),
  );
}
