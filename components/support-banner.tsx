"use client";

import { LifeBuoy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import { supportBanner } from "@/lib/session-info";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

/**
 * Shown on every page while the platform owner works inside a company. Says plainly what the session may do, offers the logged
 * step to ask for write access, and the way out. Nothing here decides access: the database does.
 */
export function SupportBanner() {
  const { session } = useUser();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const expiresAt = session?.support ? session.support_expires_at : null;

  // When the support window ends the database stops answering; send the page back to the list rather than leave it half working.
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => {
      if (Date.now() >= new Date(expiresAt).getTime()) window.location.assign("/platform");
    }, 15_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const text = supportBanner(session);
  if (!session || !text) return null;

  async function elevate(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase || !session?.organization_id) return;
    setBusy(true);
    const { error } = await supabase.rpc("platform_elevate_support", { p_org: session.organization_id, p_reason: reason, p_minutes: 30 });
    setBusy(false);
    if (error) return void toast.error(friendlyError(error, "Couldn't switch on write access."));
    window.location.reload();
  }

  async function exit() {
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.rpc("platform_exit_organization");
    if (error) {
      setBusy(false);
      return void toast.error(friendlyError(error, "Couldn't leave the company."));
    }
    window.location.assign("/platform");
  }

  return (
    <div role="status" data-testid="support-banner" className="relative z-40 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950 print:hidden md:px-6 desk:pl-[264px] desk:pr-10">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <LifeBuoy className="size-4 shrink-0" />
        <p className="min-w-0 flex-1 font-medium">{text}</p>
        {session.read_only && !asking ? <Button size="sm" variant="outline" className="border-amber-400 bg-white" disabled={busy} onClick={() => setAsking(true)}>Request write access</Button> : null}
        <Button size="sm" variant="outline" className="border-amber-400 bg-white" disabled={busy} onClick={() => void exit()}>Exit company</Button>
      </div>
      {asking ? (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => void elevate(event)}>
          <Input aria-label="Reason for write access" value={reason} maxLength={500} placeholder="Why does this need write access?" onChange={(event) => setReason(event.target.value)} className="h-9 min-w-64 flex-1 bg-white" />
          <Button type="submit" size="sm" disabled={busy || reason.trim().length < 5} className="bg-brand text-brand-ink">Switch on write access for 30 minutes</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
        </form>
      ) : null}
    </div>
  );
}
