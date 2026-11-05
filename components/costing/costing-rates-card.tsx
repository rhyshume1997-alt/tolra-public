'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCodePrompt } from '@/components/authenticator-code-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { loadCompanyRates, NOT_APPLIED_MESSAGE, ratesProblem, saveRates, type LoadedRates, type RatesSnapshot, type SaveBody } from '@/lib/costing/app-rates';
import { sendWithCode, type SendAnswer } from '@/lib/mfa-step-up';
import { supabase } from '@/lib/supabase';
import { getCurrentOrganizationId } from '@/lib/supabase-business';
import { useUser } from '@/lib/use-user';
import { CostingRatesEditor, type EditorNotice } from './costing-rates-editor';
import { blankCostingRates, type CostingRates } from './types';

export type RatesPanelProps = {
  /** The signed-in person's active role; only admin and office edit costing rates (the database says the same). */
  role: string;
  load: () => Promise<LoadedRates>;
  save: (expected: RatesSnapshot, rates: CostingRates) => Promise<SendAnswer<SaveBody>>;
  requestCode: () => Promise<boolean>;
};
const CAN_EDIT = ['admin', 'office'];

/** Settings > Costing rates, without its data hooks: everything comes in as props (this is what the tests drive). */
export function CostingRatesPanel({ role, load, save, requestCode }: RatesPanelProps) {
  const [state, setState] = useState<'loading' | 'ready' | 'not_applied' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [rates, setRates] = useState<CostingRates>(blankCostingRates);
  const [snapshot, setSnapshot] = useState<RatesSnapshot | null>(null);
  const [notice, setNotice] = useState<EditorNotice>(null);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(async (keepNotice = false) => {
    const result = await load();
    if (!alive.current) return;
    if (result.status === 'ok') { setRates(result.rates); setSnapshot(result.snapshot); setState('ready'); setStale(false); if (!keepNotice) setNotice(null); }
    else if (result.status === 'not_applied') setState('not_applied');
    else { setLoadError(result.message); setState('error'); }
  }, [load]);
  useEffect(() => { if (CAN_EDIT.includes(role)) void reload(); }, [role, reload]);

  const onSave = async () => {
    if (saving || !snapshot) return;
    const problem = ratesProblem(rates);
    if (problem) { setNotice({ tone: 'error', text: problem }); return; }
    setSaving(true); setNotice(null);
    const outcome = await sendWithCode<SaveBody>(() => save(snapshot, rates), requestCode);
    if (!alive.current) return;
    setSaving(false);
    if (outcome.result === 'cancelled') { setNotice({ tone: 'error', text: 'Not saved: no authenticator code was entered.' }); return; }
    const body = outcome.answer.body;
    if (outcome.result === 'done') { await reload(true); setNotice({ tone: 'ok', text: 'Costing rates saved.' }); return; }
    setStale(body?.kind === 'stale');
    setNotice({ tone: 'error', text: body?.message ?? "Couldn't save the costing rates. Nothing was changed. Try again." });
  };

  if (!CAN_EDIT.includes(role)) return null;
  return <Card id="setup-costing"><CardContent className="pt-6">
    {state === 'loading' ? <p className="text-sm text-slate-500">Loading costing rates…</p> : null}
    {state === 'not_applied' ? <p role="status" className="text-sm text-slate-600">{NOT_APPLIED_MESSAGE}</p> : null}
    {state === 'error' ? <p role="alert" className="text-sm text-red-700">{loadError} <Button type="button" variant="outline" size="xs" onClick={() => { setState('loading'); void reload(); }}>Try again</Button></p> : null}
    {state === 'ready' ? <CostingRatesEditor value={rates} onChange={(next) => { setRates(next); setNotice(null); }} onSave={onSave} saving={saving} notice={notice} onReload={stale ? () => void reload() : undefined} /> : null}
  </CardContent></Card>;
}

/** The Settings card: the panel wired to the signed-in company's rates. */
export function CostingRatesCard() {
  const { activeRole } = useUser();
  const { requestCode, codeDialog } = useCodePrompt();
  const load = useCallback(() => loadCompanyRates(supabase), []);
  const save = useCallback(async (expected: RatesSnapshot, rates: CostingRates): Promise<SendAnswer<SaveBody>> => {
    let organizationId: string;
    try { organizationId = await getCurrentOrganizationId(); } catch { return { ok: false, status: 401, body: { kind: 'error', message: 'Your session has ended. Sign in again.' } }; }
    return saveRates(supabase, organizationId, expected, rates);
  }, []);
  return <><CostingRatesPanel role={activeRole} load={load} save={save} requestCode={requestCode} />{codeDialog}</>;
}
