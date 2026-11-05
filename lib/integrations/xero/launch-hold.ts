import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {AccountingProvider} from '@/lib/integrations/types';
import {ProviderError} from '@/lib/integrations/types';
export const XERO_HOLD_MESSAGE = 'Xero transfers are off for this company. An admin must turn them on before anything is sent or retried.';
/** Missing migration, row or read error is OFF. Never infer enablement from a connection or credentials. */
export async function xeroTransfersEnabled(client: SupabaseClient, org: string): Promise<boolean> {
  try { const {data,error}=await client.rpc('integration_xero_transfer_enabled',{p_org:org}); return !error && data===true; }
  catch { return false; }
}
export async function requireXeroTransfers(client: SupabaseClient, org: string) {
  if (!await xeroTransfersEnabled(client,org)) throw new Error(XERO_HOLD_MESSAGE);
}
/** Recheck before each provider operation, including contact creation and retry read-back. Cannot recall an already in-flight HTTP call. */
export function heldXeroProvider(provider:AccountingProvider, enabled:()=>Promise<boolean>):AccountingProvider {
  const check=async()=>{if(!await enabled())throw new ProviderError(XERO_HOLD_MESSAGE,'unknown',0);};
  return {...provider,
    listAccounts:async()=>{await check();return provider.listAccounts();},
    listTaxRates:async()=>{await check();return provider.listTaxRates();},
    findContacts:async(...args)=>{await check();return provider.findContacts(...args);},
    createContact:async(...args)=>{await check();return provider.createContact(...args);},
    pushInvoice:async(...args)=>{await check();return provider.pushInvoice(...args);},
    pushCreditNote:async(...args)=>{await check();return provider.pushCreditNote(...args);},
    voidInvoice:async(...args)=>{await check();return provider.voidInvoice(...args);},
    readBack:async(...args)=>{await check();return provider.readBack(...args);},
  };
}
