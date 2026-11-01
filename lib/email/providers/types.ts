/** What every e-mail provider (Resend, Microsoft 365, the test mock) is given and answers. Server side only. */

export type ProviderName = "resend" | "microsoft" | "mock";

export type OutgoingEmail = {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
  /** Resend only: the same key for retries of one e-mail, so it is never sent twice. */
  idempotencyKey?: string;
};

/**
 * accepted  the provider took it;
 * failed    the provider definitely refused it (its own 4xx answer): nothing was sent;
 * unknown   no answer we can trust (network, timeout, 5xx): it may have gone, so it is NOT retried automatically.
 */
export type ProviderResult = { outcome: "accepted" | "failed" | "unknown"; providerMessageId?: string; rateLimited?: boolean; detail: string };

export interface EmailProvider {
  name: ProviderName;
  send(email: OutgoingEmail): Promise<ProviderResult>;
}
