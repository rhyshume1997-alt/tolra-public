"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type NeedsCheckingItem = { id: string; to: string; subject: string; status: string; related: string; drafted: string };

/**
 * Messages whose outcome is not known. No Approve, no retry, no "send another way": only a person who has checked the provider's sent
 * items records what happened, and that records who and when. It never sends.
 */
export function NeedsChecking({ items, isAdmin, busy, onResolve }: { items: NeedsCheckingItem[]; isAdmin: boolean; busy: boolean; onResolve: (item: NeedsCheckingItem, outcome: "sent" | "not_sent") => void }) {
  if (!items.length) return null;
  return (
    <section className="space-y-3" aria-label="Needs checking">
      <h2 className="text-xl font-semibold text-slate-950">Needs checking</h2>
      {items.map((item) => (
        <Card key={item.id} className="border-amber-300">
          <CardHeader>
            <CardTitle className="text-lg">{item.to}</CardTitle>
            <p className="text-sm text-slate-600">{item.subject}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-medium text-amber-900" role="status">
              {item.status === "sending"
                ? "This email was being sent when something stopped, so we don't know if it went."
                : "We couldn't confirm whether this email was sent."}{" "}
              It will not be sent again, and cannot be sent another way, until someone has checked your mail provider&apos;s sent items and recorded what happened.
            </p>
            {isAdmin ? (
              <div className="flex flex-col gap-2 md:flex-row">
                <Button variant="outline" disabled={busy} onClick={() => onResolve(item, "sent")}>I checked: it was sent</Button>
                <Button variant="outline" disabled={busy} onClick={() => onResolve(item, "not_sent")}>I checked: it was not sent (return to the queue)</Button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">An admin needs to check and record this.</p>
            )}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

/** The admin's explicit choice for ONE message whose send was refused for certain. Rendered only when the server said Resend may be offered. */
export function SendViaResendButton({ available, failed, disabled, onConfirm, recipient, subject }: { available: boolean; failed: boolean; disabled: boolean; onConfirm: () => void; recipient: string; subject: string }) {
  if (!available || !failed) return null;
  return (
    <Button
      variant="outline"
      disabled={disabled}
      onClick={() => { if (window.confirm(`Send this failed email through Resend instead?\n\nTo: ${recipient}\nSubject: ${subject}\n\nThis is your own choice, it is recorded against your name, and it sends the message once.`)) onConfirm(); }}
    >
      Send via Resend instead
    </Button>
  );
}
