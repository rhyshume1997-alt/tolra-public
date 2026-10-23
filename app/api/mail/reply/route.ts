import { z } from "zod";

import { replyRecipients, replyToMessage } from "@/lib/m365/graph";
import { allRecipientsAllowed, graphFailure, mailGuard, mailKey, sendAndLog } from "@/lib/m365/route";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";

const schema = z.object({
  inboundEmailId: z.string().uuid(),
  comment: z.string().trim().min(1).max(10000),
});

/** Replies to a stored inbound message, from the connected mailbox. */
export async function POST(request: Request) {
  const ctx = await mailGuard(request);
  if (isErrorResponse(ctx)) return ctx;

  const json = await readJson(request, 32 * 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { inboundEmailId, comment } = parsed.data;

  const { data: mail } = await ctx.auth.supabase
    .from("inbound_emails")
    .select("graph_message_id, subject, rfq_id")
    .eq("id", inboundEmailId)
    .eq("organization_id", ctx.auth.profile.organization_id)
    .maybeSingle();
  if (!mail) return jsonError("Message not found", 404);

  // Microsoft sends a reply to the message's Reply-To addresses when it has any, else to the sender. Ask which, and
  // check every one of them like any other recipient before anything is sent.
  let recipients: string[];
  try {
    recipients = await replyRecipients(mail.graph_message_id, ctx.config);
  } catch (err) {
    return graphFailure("mail/reply", err);
  }
  if (!(await allRecipientsAllowed(ctx.auth, recipients))) return jsonError("Recipient not allowed", 403);

  const subject = `Re: ${mail.subject ?? ""}`.trim().slice(0, 200);
  return sendAndLog(
    ctx,
    request,
    "mail/reply",
    { kind: "reply", key: mailKey("reply", inboundEmailId, subject, comment), recipients, subject, body: comment, rfqId: mail.rfq_id },
    // Microsoft is told exactly the addresses that were checked, not left to work them out again.
    () => replyToMessage(mail.graph_message_id, comment, ctx.config, recipients),
  );
}
