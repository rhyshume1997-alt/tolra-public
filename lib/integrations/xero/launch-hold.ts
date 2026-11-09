import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccountingProvider } from "@/lib/integrations/types";
import { TransfersHeldError } from "@/lib/integrations/types";

export const XERO_HOLD_MESSAGE = "Xero transfers are off for this company. An admin must turn them on before anything is sent or retried.";

/**
 * The company's Xero transfer switch (release 149), as the database answers it. A missing function (149 not applied, or rolled back), a
 * missing row, a read error or an odd answer is OFF: nothing is ever inferred from a connection or credentials. The database's claim
 * function judges the same switch again, so this is the app's early stop and the database is the one that cannot be bypassed.
 */
export async function xeroTransfersEnabled(client: SupabaseClient, org: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("integration_xero_transfer_enabled", { p_org: org });
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function requireXeroTransfers(client: SupabaseClient, org: string) {
  if (!(await xeroTransfersEnabled(client, org))) throw new Error(XERO_HOLD_MESSAGE);
}

/**
 * Re-checks the switch before every provider call (contact lookup and creation, push, void, read-back). Switched off in the middle of a send:
 * the next call is not made (TransfersHeldError: the engine puts the row back to pending), while a call already in flight cannot be recalled and
 * its real result is recorded as usual.
 */
export function heldXeroProvider(provider: AccountingProvider, enabled: () => Promise<boolean>): AccountingProvider {
  const check = async () => { if (!(await enabled())) throw new TransfersHeldError(XERO_HOLD_MESSAGE); };
  return {
    ...provider,
    listAccounts: async () => { await check(); return provider.listAccounts(); },
    listTaxRates: async () => { await check(); return provider.listTaxRates(); },
    findContacts: async (...args) => { await check(); return provider.findContacts(...args); },
    createContact: async (...args) => { await check(); return provider.createContact(...args); },
    pushInvoice: async (...args) => { await check(); return provider.pushInvoice(...args); },
    pushCreditNote: async (...args) => { await check(); return provider.pushCreditNote(...args); },
    voidInvoice: async (...args) => { await check(); return provider.voidInvoice(...args); },
    readBack: async (...args) => { await check(); return provider.readBack(...args); },
  };
}
