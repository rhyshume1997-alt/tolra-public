"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/dates";
import { missingDbObject } from "@/lib/db-features";
import { supabase } from "@/lib/supabase";

/** Shown in place of the card's controls while migration 129 is not applied. */
export const NEEDS_129 = "Not available until database update 129 is applied.";

export type AccountantInviteRow = { id: string; email: string; created_at: string; expires_at: string; used_at: string | null; revoked_at: string | null };

/** The state of one accountant invite, in words. */
export function accountantInviteState(row: AccountantInviteRow, now: number = Date.now()): { open: boolean; label: string } {
  if (row.used_at) return { open: false, label: `Accepted ${fmtDateTime(row.used_at)}` };
  if (row.revoked_at) return { open: false, label: `Cancelled ${fmtDateTime(row.revoked_at)}` };
  if (new Date(row.expires_at).getTime() <= now) return { open: false, label: `Expired ${fmtDateTime(row.expires_at)}` };
  return { open: true, label: `Open until ${fmtDateTime(row.expires_at)}` };
}

/**
 * Admin > Integrations > "Invite your accountant" (C3, migration 129). The accountant's e-mail becomes a one-use invite (7 days) to see this
 * company in Tolra as a VIEWER (read only). The admin copies the link or e-mails it from their own mail; Tolra sends nothing. The company's
 * invites are listed with their state, and an open one can be revoked. `offerXero`: Xero is set up on this server, the database has 107
 * and this company's Xero is not connected; only then the "Also connect Xero for this company" tick box is shown, and it uses the
 * existing Xero connect link (`onXeroLink` reloads the Xero card's open links). Making an invite needs the second sign-in step.
 */
export function AccountantInviteCard({ offerXero, onXeroLink }: { offerXero: boolean; onXeroLink?: () => void }) {
  const [email, setEmail] = useState("");
  const [connectXero, setConnectXero] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missing129, setMissing129] = useState(false);
  const [rows, setRows] = useState<AccountantInviteRow[]>([]);
  const [made, setMade] = useState<{ url: string; mailto: string; expiresAt: string | null; xero: boolean; xeroProblem: string | null } | null>(null);
  const [revoke, setRevoke] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    // Admins read their company's invites (RLS, 007); the token hash is not readable (129). Accountant invites are the ones with an expiry.
    const { data, error } = await supabase.from("organization_invites").select("id, email, created_at, expires_at, used_at, revoked_at")
      .not("expires_at", "is", null).order("created_at", { ascending: false }).limit(20);
    if (error) {
      if (missingDbObject(error) || error.code === "42703") setMissing129(true);
      return;
    }
    setRows((data ?? []) as AccountantInviteRow[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/accountant-invite", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, connectXero: offerXero && connectXero }),
      }).catch(() => null);
      const body = (res ? await res.json().catch(() => ({})) : {}) as { url?: string; mailto?: string; expiresAt?: string | null; xero?: boolean; xeroProblem?: string | null; error?: string };
      if (!res?.ok || !body.url || !body.mailto) {
        toast.error(body.error ?? "Couldn't make the invite. Try again.");
        return;
      }
      setMade({ url: body.url, mailto: body.mailto, expiresAt: body.expiresAt ?? null, xero: body.xero === true, xeroProblem: body.xeroProblem ?? null });
      setEmail("");
      if (body.xero) onXeroLink?.();
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      toast.success("Link copied. Send it to the accountant: it works once, for 7 days.");
    } catch {
      toast.error("Couldn't copy: select the link and copy it.");
    }
  }

  async function confirmRevoke() {
    const id = revoke;
    setRevoke(null);
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/integrations/accountant-invite?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => null);
      const body = (res ? await res.json().catch(() => ({})) : {}) as { error?: string };
      if (!res?.ok) toast.error(body.error ?? "Couldn't cancel the invite. Try again.");
      else toast.success("Invite cancelled: the link no longer works.");
      setMade(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="accountant-invite-card">
      <CardHeader>
        <CardTitle>Your accountant</CardTitle>
        <CardDescription>
          Invite your accountant to see this company in Tolra as a viewer: read only, nothing can be changed. The invite works once and lasts 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {missing129 ? (
          <p className="text-sm text-slate-500" data-testid="accountant-invite-needs-129">{NEEDS_129}</p>
        ) : (
          <>
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (!busy && email.trim()) void create(); }}>
              <Input type="email" required aria-label="Accountant's email" placeholder="accountant@firm.co.uk" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-0 flex-1" data-testid="accountant-invite-email" />
              <Button type="submit" disabled={busy || !email.trim()}>Invite your accountant</Button>
            </form>
            {offerXero ? (
              <label className="flex items-center gap-2 text-sm text-slate-700" data-testid="accountant-invite-xero">
                <input type="checkbox" checked={connectXero} onChange={(e) => setConnectXero(e.target.checked)} />
                Also connect Xero for this company (the invite page offers the Xero sign-in; that step works for 24 hours)
              </label>
            ) : null}
            {made ? (
              <div className="space-y-1" data-testid="accountant-invite-made">
                <div className="flex flex-wrap items-center gap-2">
                  <input readOnly aria-label="Invite link" value={made.url} onFocus={(e) => e.currentTarget.select()} className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 font-mono text-xs" data-testid="accountant-invite-url" />
                  <Button variant="outline" size="sm" onClick={copy}>Copy link</Button>
                  <a href={made.mailto} className="inline-flex h-9 items-center rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900">Email it to them</a>
                </div>
                <p className="text-xs text-slate-500">
                  Works once, for that e-mail only{made.expiresAt ? `, until ${fmtDateTime(made.expiresAt)}` : ""}.{made.xero ? " It also offers the Xero sign-in for this company." : ""}
                </p>
                {made.xeroProblem ? <p className="text-xs text-amber-800">{made.xeroProblem}</p> : null}
              </div>
            ) : null}
            {rows.length ? (
              <ul className="space-y-1" data-testid="accountant-invites">
                {rows.map((row) => {
                  const state = accountantInviteState(row);
                  return (
                    <li key={row.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <span>{row.email}: {state.label}</span>
                      {state.open ? <Button variant="outline" size="sm" onClick={() => setRevoke(row.id)} disabled={busy}>Revoke</Button> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={revoke !== null}
        title="Revoke this invite?"
        description="The link stops working at once. A person who already joined keeps their access: change it in Settings > Users."
        confirmLabel="Revoke invite"
        onConfirm={confirmRevoke}
        onCancel={() => setRevoke(null)}
      />
    </Card>
  );
}
