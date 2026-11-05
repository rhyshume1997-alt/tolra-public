"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The plain-words choice shown above the two e-mail cards on Admin > Integrations: which one to use. No new provider: Microsoft 365 or Resend. */
export const EMAIL_CHOICE_OUTLOOK = "Outlook or Microsoft 365 email: use Connect Microsoft 365 below. Quotes, invoices and reminders then go out from your own mailbox.";
export const EMAIL_CHOICE_OTHER = "Any other email: Tolra sends from its own verified sender address using Resend (the Resend card below).";
export const EMAIL_CHOICE_APPROVAL = "Either way, nothing is e-mailed to a customer until someone approves it.";

export function EmailChoiceGuide() {
  return (
    <Card data-testid="email-choice-guide">
      <CardHeader>
        <CardTitle>Which e-mail should Tolra send from?</CardTitle>
        <CardDescription>Pick one of the two below. You do not need both.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <p>{EMAIL_CHOICE_OUTLOOK}</p>
        <p>{EMAIL_CHOICE_OTHER}</p>
        <p className="text-muted-foreground">{EMAIL_CHOICE_APPROVAL}</p>
      </CardContent>
    </Card>
  );
}
