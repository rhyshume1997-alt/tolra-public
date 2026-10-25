"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { friendlyError } from "@/lib/friendly-error";
import {
  type MappingKind, type MappingRow, type XeroAccount, type XeroTaxRate, mappedCode, mappingCompleteness, matchingTaxRates, vatKeysToShow,
} from "@/lib/integrations/mappings";
import { vatKeyLabel } from "@/lib/integrations/overview";
import { supabase } from "@/lib/supabase";

type Lists = { accounts: XeroAccount[]; taxRates: XeroTaxRate[] };

/** The completeness line (pure: rendered in tests): what still stops sending, or that everything used is set. */
export function MappingStatus({ rows, unmapped }: { rows: MappingRow[]; unmapped: string[] }) {
  const { ready, message } = mappingCompleteness(rows, unmapped);
  return ready ? (
    <p className="rounded-md border border-green-300 bg-green-50 p-2 text-sm text-green-900" data-testid="xero-mapping-ready">
      Both accounts are set and every VAT rate in use has a Xero tax rate. Documents are sent.
    </p>
  ) : (
    <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="xero-mapping-missing">{message}</p>
  );
}

function Picker({ label, value, savedName, options, disabled, onChange, note }: {
  label: string;
  value: string;
  savedName: string | null;
  options: Array<{ value: string; label: string }> | null;
  disabled: boolean;
  onChange: (code: string) => void;
  note?: string | null;
}) {
  // Until Xero's lists are read (or when they can't be), the saved choice is shown as it was saved.
  const list = options ?? (value ? [{ value, label: savedName ? `${value} · ${savedName}` : value }] : []);
  const withSaved = value && !list.some((o) => o.value === value) ? [{ value, label: `${value}${savedName ? ` · ${savedName}` : ""} (not in Xero's list)` }, ...list] : list;
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:items-center">
      <span className="text-sm font-medium">{label}</span>
      <div>
        <select aria-label={label} value={value} disabled={disabled || !options} onChange={(e) => onChange(e.target.value)} className="h-9 w-full max-w-md rounded-lg border px-2 text-sm">
          <option value="">Not set</option>
          {withSaved.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {note ? <p className="mt-1 text-xs text-slate-600">{note}</p> : null}
      </div>
    </div>
  );
}

/**
 * Admin > Integrations > Mappings: the sales account, the credit note account and a Xero tax rate for each Tolra VAT rate. Xero's lists
 * are read on the server (GET /api/integrations/xero/mappings); each choice is saved through the server, which refuses a tax rate whose
 * percentage is not the Tolra rate's, and the database saves it as this admin (two-step checked). Nothing sends until every rate in use
 * and both accounts are set (084's gate); this card says what is missing.
 */
export function XeroMappings({ connected, unmapped, onChanged }: { connected: boolean; unmapped: string[]; onChanged: () => void }) {
  const [rows, setRows] = useState<MappingRow[] | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const loadRows = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from("integration_mappings").select("kind, tolra_key, external_code, external_name").eq("provider", "xero");
    if (error) toast.error(friendlyError(error, "Couldn't load the mappings."));
    else setRows((data ?? []) as MappingRow[]);
  }, []);

  const loadLists = useCallback(async () => {
    setListError(null);
    const res = await fetch("/api/integrations/xero/mappings", { credentials: "same-origin" }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as Partial<Lists> & { error?: string };
    if (!res?.ok) {
      setListError(body?.error ?? "Couldn't read Xero's accounts and tax rates. Try again.");
      return;
    }
    setLists({ accounts: body.accounts ?? [], taxRates: body.taxRates ?? [] });
  }, []);

  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => { if (connected) void loadLists(); }, [connected, loadLists]);

  async function save(kind: MappingKind, tolraKey: string, code: string) {
    const id = `${kind}:${tolraKey}`;
    setSaving(id);
    try {
      const res = await fetch("/api/integrations/xero/mappings", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, tolraKey, code }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) toast.error(body.error ?? "Couldn't save the mapping. Try again.");
      else toast.success(code ? "Saved." : "Removed.");
    } finally {
      setSaving(null);
      await loadRows();
      onChanged();
    }
  }

  if (!rows) return <Card><CardContent className="p-6 text-sm text-slate-500">Loading…</CardContent></Card>;

  const accountOptions = lists ? lists.accounts.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` })) : null;
  const usedVat = new Set(unmapped.filter((u) => u.startsWith("vat:")).map((u) => u.slice(4)));
  const sales = mappedCode(rows, "sales_account");
  const credit = mappedCode(rows, "credit_account");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mappings</CardTitle>
        <CardDescription>Where Tolra&apos;s invoices and credit notes go in Xero. Set once; your accountant can tell you which to pick.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MappingStatus rows={rows} unmapped={unmapped} />
        {!connected ? <p className="text-sm text-slate-600">Connect to Xero to change these.</p> : null}
        {connected && listError ? <p className="text-sm text-red-700" role="alert">{listError}</p> : null}
        {connected && !lists && !listError ? <p className="text-sm text-slate-500">Reading Xero&apos;s accounts and tax rates…</p> : null}
        <div className="space-y-3">
          <Picker label="Sales account" value={sales?.external_code ?? ""} savedName={sales?.external_name ?? null} options={accountOptions}
                  disabled={!connected || saving !== null} onChange={(code) => void save("sales_account", "", code)} />
          <Picker label="Credit note account" value={credit?.external_code ?? ""} savedName={credit?.external_name ?? null} options={accountOptions}
                  disabled={!connected || saving !== null} onChange={(code) => void save("credit_account", "", code)} />
        </div>
        <div className="space-y-3">
          <p className="text-sm font-semibold">VAT rates</p>
          {vatKeysToShow(rows, unmapped).map((key) => {
            const saved = mappedCode(rows, "tax_rate", key);
            const matching = lists ? matchingTaxRates(key, lists.taxRates) : null;
            const options = matching ? matching.map((t) => ({ value: t.code, label: `${t.name || t.code} (${t.rate}%)` })) : null;
            const note = matching && !matching.length
              ? `Xero has no tax rate at ${key === "exempt" || key === "no_vat" ? "0" : key}%. Add one in Xero, then reload this page.`
              : usedVat.has(key) && !saved ? "Used by a document waiting to send." : null;
            return (
              <Picker key={key} label={`VAT ${vatKeyLabel(key)}`} value={saved?.external_code ?? ""} savedName={saved?.external_name ?? null} options={options}
                      disabled={!connected || saving !== null} onChange={(code) => void save("tax_rate", key, code)} note={note} />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
