import "server-only";

import type { EmailProvider, OutgoingEmail } from "@/lib/email/providers/types";

/**
 * The test provider (EMAIL_PROVIDER=mock; refused on any Vercel deployment by lib/email/send-company-email.ts). Sends nothing: keeps
 * the e-mails in memory for the test that asked. An address at "refused.example.test" is refused (to test the failed path).
 */
export const mockOutbox: OutgoingEmail[] = [];

export function mockProvider(): EmailProvider {
  return {
    name: "mock",
    async send(email) {
      if ([...email.to, ...email.cc].some((address) => address.endsWith("@refused.example.test"))) return { outcome: "failed", detail: "mock refused" };
      mockOutbox.push(email);
      return { outcome: "accepted", detail: "mock", providerMessageId: `mock-${mockOutbox.length}` };
    },
  };
}
