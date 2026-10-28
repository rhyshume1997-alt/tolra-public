"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2, Wifi } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import { newClientOpId } from "@/lib/machine-runs";
import {
  type RequestNetwork, type SavedNetwork, type SiteNetworkMode, NETWORK_PROBLEM_TEXT, addSiteNetwork, formatNetwork, loadSiteNetworks,
  SITE_NETWORK_IP_RETENTION_DAYS, myRequestNetwork, parseNetwork, purgeSiteNetworkIps, removeSiteNetwork, setSiteNetworkCheck,
} from "@/lib/site-network";
import { supabase } from "@/lib/supabase";
import { useDatabaseHas075 } from "@/lib/use-database-has-075";

/**
 * Settings > Network (075, B40 phase 1): the site's public network(s) and the clock-in check (Off, or Flag: on-site-only people's clock
 * actions from another network are flagged for the office, never refused). Admin only (the Settings page is). Hidden until the database
 * has 075. "Use the network I'm on now" saves the address this browser reaches the server from (the call goes straight from the
 * browser to the database, so it is this device's network). With 078 the card says how long a checked clock action's address is kept
 * and lets the admin delete the expired addresses now (the default) or, after a confirmation naming what goes, all of them. Admin only
 * (the Settings page is; the database refuses anyone else). A network is only ever saved by one of the two buttons below (never automatically).
 */
export function SiteNetworkCard() {
  const has075 = useDatabaseHas075() === true;
  const [mode, setMode] = useState<SiteNetworkMode | null>(null);
  const [networks, setNetworks] = useState<SavedNetwork[]>([]);
  const [here, setHere] = useState<RequestNetwork | null>(null);
  const [ipRetention, setIpRetention] = useState(false);
  const [label, setLabel] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !has075) return;
    try {
      const state = await loadSiteNetworks(supabase);
      setMode(state.mode);
      setNetworks(state.networks);
      setIpRetention(state.ipRetention);
      setHere(await myRequestNetwork(supabase).catch(() => null));
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "Couldn't load the site network settings."));
    }
  }, [has075]);
  useEffect(() => { void load(); }, [load]);

  async function run(what: () => Promise<unknown>, done: string, failed: string) {
    setBusy(true);
    try {
      await what();
      toast.success(done);
      await load();
      return true;
    } catch (err) {
      toast.error(friendlyError(err, failed));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!has075) return null;
  const typedCheck = typed.trim() ? parseNetwork(typed) : null;
  return (
    <Card data-testid="site-network-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><Wifi className="size-5 text-brand-accent" /> Site network (clock-in check)</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          A phone can&apos;t tell Tolra which Wi-Fi it is on. Tolra sees the public internet address a clock in comes from: every device on the
          site Wi-Fi shares the router&apos;s one address. With the check on <strong>Flag</strong>, clock actions of people marked{" "}
          <strong>On site only</strong> (Admin &gt; Users) that come from another network are flagged for the office. <strong>Nothing is ever
          refused.</strong> Clock actions saved offline and synced later show &ldquo;synced later, network unknown&rdquo;. Off: nothing is checked
          or recorded. If the broadband provider changes the address, every check shows &ldquo;not on the site network&rdquo; until you save the
          new one here; ask the provider for a fixed (static) address.
        </p>
        {ipRetention ? (
          <p className="text-slate-600 dark:text-slate-300" data-testid="site-network-retention">
            The internet address of each checked clock action is kept for {SITE_NETWORK_IP_RETENTION_DAYS} days, then deleted. Whether it was on
            the site network, and the flag, are kept. A new address is never trusted on its own: only the buttons below save a network.
          </p>
        ) : null}
        {error ? <p className="text-red-700">{error}</p> : null}
        {here ? (
          <p className="rounded-none border p-2 text-slate-700" data-testid="site-network-here">
            This device reaches Tolra from <span className="font-mono">{here.ip ?? "an address Tolra can't see"}</span>
            {here.ip ? (here.on_saved_network ? ": a saved site network." : ": not a saved site network.") : "."}
          </p>
        ) : null}
        <div className="space-y-2">
          <p className="font-medium text-slate-800">Saved site networks</p>
          {networks.length ? (
            <ul className="space-y-1">
              {networks.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-2 rounded-none border p-2" data-testid="site-network-row">
                  <span><span className="font-medium">{n.label}</span> <span className="font-mono text-slate-600">{n.network}</span></span>
                  <Button size="sm" variant="outline" disabled={busy} aria-label={`Remove ${n.label}`}
                    onClick={() => supabase && void run(() => removeSiteNetwork(supabase!, newClientOpId(), n.id), `${n.label} removed.`, "Couldn't remove it.")}>
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : <p className="text-slate-500">None saved yet.</p>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Input className="max-w-48" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Name, e.g. Workshop" aria-label="Network name" />
          <Button disabled={busy || !here?.ip || here.private === true} data-testid="use-this-network"
            onClick={() => supabase && void run(() => addSiteNetwork(supabase!, newClientOpId(), null, label.trim() || null), "This network is saved.", "Couldn't save this network.").then((ok) => ok && setLabel(""))}>
            Use the network I&apos;m on now
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Input className="max-w-64 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={64} placeholder="or type 203.0.113.7 or 203.0.113.0/28" aria-label="Network address" />
          <Button variant="outline" disabled={busy || !typedCheck?.ok}
            onClick={() => supabase && typedCheck?.ok && void run(() => addSiteNetwork(supabase!, newClientOpId(), formatNetwork(typedCheck.network), label.trim() || null), "Network saved.", "Couldn't save that network.").then((ok) => { if (ok) { setTyped(""); setLabel(""); } })}>
            Add
          </Button>
          {typedCheck && !typedCheck.ok ? <span className="text-amber-800">{NETWORK_PROBLEM_TEXT[typedCheck.problem]}</span> : null}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>
            <span className="font-medium text-slate-800">Check clock-ins: {mode === "flag" ? "Flag" : "Off"}</span>
            <span className="block text-xs text-slate-500">{networks.length ? "Flag only: never refuses a clock in." : "Save the site network first."}</span>
          </span>
          <Button size="sm" variant={mode === "flag" ? "outline" : "default"} disabled={busy || mode === null || (mode === "off" && !networks.length)} data-testid="site-network-switch"
            onClick={() => supabase && void run(() => setSiteNetworkCheck(supabase!, newClientOpId(), mode === "flag" ? "off" : "flag"), mode === "flag" ? "The clock-in check is off." : "Clock-ins are now checked (flag only).", "Couldn't change the check.")}>
            {mode === "flag" ? "Turn off" : "Turn on (flag only)"}
          </Button>
        </div>
        {ipRetention ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Kept clock-in addresses: older than {SITE_NETWORK_IP_RETENTION_DAYS} days are deleted automatically.</span>
            <span className="flex gap-2">
              <Button size="sm" disabled={busy} data-testid="site-network-purge-expired"
                onClick={() => supabase && void run(() => purgeSiteNetworkIps(supabase!, false), "Expired addresses deleted.", "Couldn't delete the expired addresses.")}>
                Delete expired addresses
              </Button>
              <Button size="sm" variant="outline" disabled={busy} data-testid="site-network-purge-all" onClick={() => setConfirmPurgeAll(true)}>
                Delete all
              </Button>
            </span>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirmPurgeAll}
          title="Delete every kept clock-in address?"
          description={`This deletes the internet address of every checked clock action in this company, including those from the last ${SITE_NETWORK_IP_RETENTION_DAYS} days. Whether each one was on the site network, and its flag, are kept. Deleted addresses can't be brought back.`}
          confirmLabel="Delete all addresses"
          cancelLabel="Keep them"
          destructive
          busy={busy}
          onCancel={() => setConfirmPurgeAll(false)}
          onConfirm={() => {
            setConfirmPurgeAll(false);
            if (supabase) void run(() => purgeSiteNetworkIps(supabase!, true), "All kept addresses deleted.", "Couldn't delete the kept addresses.");
          }}
        />
      </CardContent>
    </Card>
  );
}
