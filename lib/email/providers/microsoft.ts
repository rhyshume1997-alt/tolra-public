import "server-only";

import type { EmailProvider, OutgoingEmail, ProviderResult } from "@/lib/email/providers/types";
import { SEND_TIMEOUT_MS } from "@/lib/send-outcome";

export const GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

/** Graph's inline attachment limit (larger files need an upload session). */
export const GRAPH_INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

const recipients = (addresses: string[]) => addresses.map((address) => ({ emailAddress: { address } }));

/** The Graph sendMail request body: from the signed-in (connected) mailbox, saved to its Sent Items. */
export function graphMessage(email: OutgoingEmail) {
  return {
    message: {
      subject: email.subject,
      body: email.html ? { contentType: "HTML", content: email.html } : { contentType: "Text", content: email.text },
      toRecipients: recipients(email.to),
      ...(email.cc.length ? { ccRecipients: recipients(email.cc) } : {}),
      ...(email.attachments.length
        ? { attachments: email.attachments.map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.filename, contentType: a.contentType, contentBytes: a.content.toString("base64") })) }
        : {}),
    },
    saveToSentItems: true,
  };
}

/**
 * Microsoft 365: sends as the company's connected mailbox through Graph /me/sendMail with a delegated token (Mail.Send) from
 * lib/integrations/microsoft/token-source.ts. 202 = accepted; a 4xx (other than 408/409) = refused; 429 = refused and rate limited;
 * a 5xx, a network error or no answer within 15 seconds = unknown (it may have gone).
 */
export function microsoftProvider(accessToken: string, fetchImpl: typeof fetch = fetch, timeoutMs = SEND_TIMEOUT_MS): EmailProvider {
  return {
    name: "microsoft",
    async send(email: OutgoingEmail): Promise<ProviderResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(GRAPH_SEND_MAIL_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(graphMessage(email)),
          signal: controller.signal,
          cache: "no-store",
        });
        const status = response.status;
        if (status === 202 || status === 200) return { outcome: "accepted", detail: `graph ${status}`, providerMessageId: response.headers.get("request-id") ?? undefined };
        if (status === 429) return { outcome: "failed", rateLimited: true, detail: "graph 429" };
        if (status >= 400 && status < 500 && status !== 408 && status !== 409) return { outcome: "failed", detail: `graph ${status}` };
        return { outcome: "unknown", detail: `graph ${status}` };
      } catch (err) {
        return { outcome: "unknown", detail: err instanceof Error ? err.name : "threw" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
