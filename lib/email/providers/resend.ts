import "server-only";
import { Resend } from "resend";

import type { EmailProvider, OutgoingEmail, ProviderResult } from "@/lib/email/providers/types";
import { sendWithOutcome } from "@/lib/send-outcome";

type ResendLike = { emails: { send: Resend["emails"]["send"] } };

/**
 * Resend (RESEND_API_KEY, sender EMAIL_FROM on a domain verified in Resend). The same call pattern as /api/send-job (which keeps its
 * own reserve_job_email ledger and is unchanged): the outcome classified by lib/send-outcome, an idempotency key so a retry of the same
 * e-mail is never sent twice.
 */
export function resendProvider(apiKey: string, from: string, client: ResendLike = new Resend(apiKey)): EmailProvider {
  return {
    name: "resend",
    async send(email: OutgoingEmail): Promise<ProviderResult> {
      let providerMessageId: string | undefined;
      let rateLimited = false;
      const { outcome, detail } = await sendWithOutcome(async () => {
        const answer = await client.emails.send(
          {
            from,
            to: email.to,
            ...(email.cc.length ? { cc: email.cc } : {}),
            subject: email.subject,
            text: email.text,
            ...(email.html ? { html: email.html } : {}),
            ...(email.attachments.length ? { attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
          },
          email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : undefined,
        );
        providerMessageId = answer.data?.id ?? undefined;
        rateLimited = answer.error?.statusCode === 429;
        return answer;
      });
      return { outcome, detail, providerMessageId, rateLimited };
    },
  };
}
