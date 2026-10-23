import { resend } from "@/lib/resend";

type DraftEmailInput = {
  to: string;
  subject: string;
  body: string;
};

export async function sendEmail(input: DraftEmailInput) {
  if (!resend) {
    return { ok: false, status: "drafted" as const, reason: `RESEND_API_KEY is not configured for ${input.to}` };
  }
  const draftHtml = input.body.replaceAll("\n", "<br />");
  return {
    ok: false,
    status: "drafted" as const,
    reason: `Auto-send disabled until domain email is verified for ${input.to}`,
    draft: { to: input.to, subject: input.subject, html: draftHtml },
  };
}
