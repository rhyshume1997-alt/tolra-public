"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { RoleGate } from "@/components/role-gate";
import { postIntegrationWithCode } from "@/lib/integrations/post-with-code";

type Offer = { organisations: Array<{ tenantId: string; name: string }>; csrf: string; expiresAt: number };

/**
 * Admin > Integrations > choose the Xero organisation. Shown when one Xero consent made several organisations: only those are listed, none
 * is selected, and nothing connects until the admin picks one and presses the button (with a fresh authenticator code, as for Connect).
 * Connecting never turns transfers on or releases held documents.
 */
export default function XeroOrganisationPage() {
  const { requestCode, codeDialog } = useCodePrompt();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/integrations/xero/choose", { credentials: "same-origin" })
      .then(async (res) => (res.ok ? ((await res.json()) as Offer) : null))
      .catch(() => null)
      .then((value) => { if (active) { if (value) setOffer(value); else setProblem("There is nothing to choose any more. Click Connect to Xero again."); } });
    return () => { active = false; };
  }, []);

  async function connect() {
    if (!offer || !chosen) return;
    setBusy(true);
    setProblem(null);
    const r = await postIntegrationWithCode("/api/integrations/xero/choose", requestCode, { tenantId: chosen, csrf: offer.csrf });
    setBusy(false);
    if (r.ok) window.location.assign("/admin/integrations?xero=connected");
    else setProblem(r.error);
  }

  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-4" data-testid="xero-organisation-picker">
        <h1 className="page-title">Choose the Xero organisation</h1>
        <p className="text-sm text-slate-500">You gave Tolra access to more than one Xero organisation. Choose the one for this company. The others are disconnected again.</p>
        {offer ? (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="sr-only">Xero organisation</legend>
            {offer.organisations.map((o) => (
              <label key={o.tenantId} className="flex items-center gap-2 rounded border p-3 text-sm">
                <input type="radio" name="tenant" value={o.tenantId} checked={chosen === o.tenantId} onChange={() => setChosen(o.tenantId)} />
                <span>{o.name || "Unnamed organisation"}</span>
              </label>
            ))}
            <button type="button" className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={!chosen || busy} onClick={() => void connect()}>
              Connect this organisation
            </button>
          </fieldset>
        ) : null}
        {problem ? <p role="alert" className="text-sm text-red-700">{problem}</p> : null}
        <p className="text-sm"><Link href="/admin/integrations" className="underline">Back to Integrations</Link>.Nothing is connected until you choose.</p>
        {codeDialog}
      </div>
    </RoleGate>
  );
}
