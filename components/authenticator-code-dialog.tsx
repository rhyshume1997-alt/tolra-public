"use client";

import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createCodeRequester, verifyAuthenticatorCode } from "@/lib/mfa-step-up";
import { supabase } from "@/lib/supabase";

/**
 * Asks an admin for a fresh authenticator code before a password change or a sensitive admin action (G1). `onVerified` runs once a code verified (the session is
 * then aal2 with a new code time); `onCancel` changes nothing. A wrong code shows a plain error and can be retried.
 */
export function AuthenticatorCodeDialog({ open, onVerified, onCancel }: { open: boolean; onVerified: () => void | Promise<void>; onCancel: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setMessage(null);
    const result = await verifyAuthenticatorCode(supabase?.auth.mfa, String(new FormData(form).get("code") || ""));
    if (!result.ok) {
      setMessage(result.message);
      setBusy(false);
      return;
    }
    form.reset();
    await onVerified();
    setBusy(false);
  }

  function cancel() {
    setMessage(null);
    onCancel();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) cancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enter your code</DialogTitle>
          <DialogDescription>Enter the 6-digit code from your authenticator app</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input name="code" aria-label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} placeholder="123456" className="h-11" autoFocus />
          {message ? <p role="alert" className="text-sm text-red-700">{message}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy} className="min-h-11 flex-1 bg-brand text-brand-ink hover:bg-brand-hover">{busy ? "Checking…" : "Confirm"}</Button>
            <Button type="button" variant="outline" disabled={busy} className="min-h-11" onClick={cancel}>Cancel</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * For a page that sends sensitive requests through sendWithCode (lib/mfa-step-up.ts): `requestCode` opens the dialog and resolves true
 * once a code verified, false when it was cancelled (a second request while the dialog is open waits for the same answer); render
 * `codeDialog` once in the page.
 */
export function useCodePrompt() {
  const [asking, setAsking] = useState(false);
  const requester = useRef<ReturnType<typeof createCodeRequester> | null>(null);
  if (!requester.current) requester.current = createCodeRequester(setAsking);
  const requestCode = useCallback(() => requester.current!.request(), []);
  const settle = useCallback((verified: boolean) => requester.current!.settle(verified), []);
  const codeDialog = <AuthenticatorCodeDialog open={asking} onVerified={() => settle(true)} onCancel={() => settle(false)} />;
  return { requestCode, codeDialog };
}
