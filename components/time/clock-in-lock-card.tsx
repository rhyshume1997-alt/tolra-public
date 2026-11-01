"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ClockInLock, clockInLockDecision, databaseHas114, loadClockInLock, loadOffSiteAllowed, lockClockIn, unlockClockIn } from "@/lib/clock-in-lock";
import { loadCompanyPeople } from "@/lib/company-people";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { UNKNOWN } from "@/lib/people";
import { type RequestNetwork, loadSiteNetworks, myRequestNetwork } from "@/lib/site-network";
import { supabase } from "@/lib/supabase";
import { useDatabaseHas075 } from "@/lib/use-database-has-075";

/**
 * Settings > Clock-in network lock (114, M27). One button locks clock-in to the network this device is on: the database reads the
 * address this browser's request reaches it from (the call goes straight from the browser to the database), never an address typed or
 * sent by the browser. Locked: "Locked to <network> since <date> by <admin>", with Re-capture and Unlock. Admin only (the Settings page
 * is; the database refuses anyone else, and an admin before the second step of sign-in where the company requires it). Hidden until the
 * database has 075 and 114, so nothing changes until both are applied. Off (unlocked) by default.
 */
export function ClockInLockCard() {
  const has075 = useDatabaseHas075() === true;
  const [has114, setHas114] = useState(false);
  const [lock, setLock] = useState<ClockInLock | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [here, setHere] = useState<RequestNetwork | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [offSiteCount, setOffSiteCount] = useState<number | null>(null);
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [confirm, setConfirm] = useState<"lock" | "unlock" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!has075) return;
    let active = true;
    void databaseHas114(supabase).then((v) => { if (active) setHas114(v); });
    return () => { active = false; };
  }, [has075]);

  const load = useCallback(async () => {
    if (!supabase || !has075 || !has114) return;
    try {
      setLock(await loadClockInLock(supabase));
      setLoaded(true);
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "Couldn't load the clock-in lock."));
    }
    // Each of these only adds detail to the card: a failure leaves it out, never guesses it.
    setHere(await myRequestNetwork(supabase).catch(() => null));
    setSaved(await loadSiteNetworks(supabase).then((s) => s.networks.map((n) => n.network), () => []));
    setOffSiteCount(await loadOffSiteAllowed(supabase).then((s) => s.size, () => null));
    setNames((await loadCompanyPeople(supabase).catch(() => null)) ?? {});
  }, [has075, has114]);
  useEffect(() => { void load(); }, [load]);

  async function run(what: () => Promise<unknown>, done: string, failed: string) {
    setBusy(true);
    try {
      await what();
      toast.success(done);
    } catch (err) {
      toast.error(friendlyError(err, failed));
    } finally {
      setBusy(false);
      setConfirm(null);
      await load();
    }
  }

  if (!has075 || !has114) return null;
  const hereNetwork = here?.network ?? null;
  const canCapture = Boolean(here?.ip) && here?.private !== true;
  const fromHere = lock && here?.ip
    ? clockInLockDecision({ lockedNetwork: lock.network, savedNetworks: saved, source: "clock", deviceAt: null, receivedAt: new Date(), ip: here.ip, offSiteAllowed: false })
    : null;
  const lockedBy = lock?.locked_by ? names[lock.locked_by] ?? UNKNOWN : UNKNOWN;
  /** One Lock captures one address family; a dual-stack network may reach Tolra in the other one too. */
  const lockFamily = lock?.network.includes(":") ? "IPv6" : "IPv4";
  return (
    <Card data-testid="clock-in-lock-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><Lock className="size-5 text-brand-accent" /> Clock-in network lock</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          Lock clock-in to the network this device is on now (e.g. press it on John&apos;s office PC on the workshop Wi-Fi). Everyone clocks in
          from this network unless an admin marks them as able to clock in off site (Admin &gt; Users: <strong>Can clock in off site</strong>).
          While locked, clocking in, clocking out and breaks from anywhere other than this network or a saved site network above are{" "}
          <strong>refused</strong>. The office or an admin can still add or correct time on the sheet. A clock action saved offline and synced later can&apos;t prove where it was made: it is
          kept and shown as &ldquo;network not checked&rdquo; in Weekly hours. If the broadband address changes, clock-ins are refused until you
          re-capture here: ask the provider for a fixed (static) address first.
        </p>
        {error ? <p className="text-red-700">{error}</p> : null}
        {offSiteCount ? (
          <p className="text-slate-600" data-testid="clock-in-lock-off-site">{offSiteCount === 1 ? "1 person" : `${offSiteCount} people`} can clock in off site.</p>
        ) : null}
        {here ? (
          <p className="rounded-none border p-2 text-slate-700" data-testid="clock-in-lock-here">
            This device reaches Tolra from <span className="font-mono">{here.ip ?? "an address Tolra can't see"}</span>
            {fromHere ? (fromHere.decision === "refused" ? ": not the locked network (a clock-in from here would be refused)." : ": clock-ins from here go in.") : "."}
          </p>
        ) : null}
        {loaded ? (
          lock ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <span data-testid="clock-in-lock-state">
                Locked to <span className="font-mono">{lock.network}</span> ({lockFamily}) since {fmtDateTime(lock.locked_at)} by {lockedBy}.
                <span className="mt-1 block text-xs text-slate-500" data-testid="clock-in-lock-family">
                  Locked to {lock.network} ({lockFamily}). If your broadband also uses the other kind of address, add it under Site network
                  above, or press Re-capture from a device on that address.
                </span>
              </span>
              <span className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy || !canCapture} data-testid="clock-in-lock-recapture" onClick={() => setConfirm("lock")}>Re-capture</Button>
                <Button size="sm" variant="outline" disabled={busy} data-testid="clock-in-lock-unlock" onClick={() => setConfirm("unlock")}>Unlock</Button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <span data-testid="clock-in-lock-state">Unlocked: clock-in works from any network.</span>
              <Button size="sm" disabled={busy || !canCapture} data-testid="clock-in-lock-button" onClick={() => setConfirm("lock")}>Lock clock-in to this network</Button>
            </div>
          )
        ) : null}
        <ConfirmDialog
          open={confirm === "lock"}
          title={lock ? "Re-capture the clock-in network?" : "Lock clock-in to this network?"}
          description={`Clock-in will be locked to ${hereNetwork ?? "this device's network"}${lock ? ` instead of ${lock.network}` : ""}. Everyone not marked as able to clock in off site can then clock in only from it (or a saved site network). Only do this on the workshop network.`}
          confirmLabel={lock ? "Re-capture" : "Lock"}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => supabase && void run(() => lockClockIn(supabase!), lock ? "Clock-in network re-captured." : "Clock-in is locked to this network.", "Couldn't lock clock-in.")}
        />
        <ConfirmDialog
          open={confirm === "unlock"}
          title="Unlock clock-in?"
          description="Everyone can then clock in from any network again."
          confirmLabel="Unlock"
          destructive
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => supabase && void run(() => unlockClockIn(supabase!), "Clock-in is unlocked.", "Couldn't unlock clock-in.")}
        />
      </CardContent>
    </Card>
  );
}
