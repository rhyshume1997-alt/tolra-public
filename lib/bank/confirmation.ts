import type { SupabaseClient } from "@supabase/supabase-js";
import type { BankLine, Invoice } from "./match-statement";
import { fromPence } from "@/lib/money";
/** Same file, row and invoice produce the same UUID across retries and reuploads. */
export async function bankPaymentRequestId(csv: string, index: number, invoiceId: string): Promise<string> {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`bank-v1\0${invoiceId}\0${index}\0${csv}`));
  const h=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Optional manual-confirmation adapter. Existing RPC enforces company/role checks and idempotency. */
export async function recordConfirmedBankPayment(db: SupabaseClient, invoice: Invoice, line: BankLine, requestId: string) {
  if(!Number.isSafeInteger(line.amountPence)||line.amountPence<=0||line.amountPence!==invoice.balancePence)throw new Error("Check the payment amount against the invoice first.");
  const at=Date.parse(line.date+'T00:00:00Z');
  if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,10)!==line.date||!/^\d{4}-\d{2}-\d{2}$/.test(line.date))throw new Error("Check the payment date first.");
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))throw new Error("The payment check needs to be restarted.");
  const {data,error}=await db.rpc("record_invoice_payment",{p_request_id:requestId,p_invoice:invoice.id,p_amount:fromPence(line.amountPence),p_paid_on:line.date,p_method:"BACS",p_reference:line.description.slice(0,100)});
  if(error)throw error;
  if(!data || !['paid','partial'].includes(data.status)||!Number.isFinite(Number(data.amount_paid)))throw new Error("Check whether the payment was saved before trying again.");
  return data;
}
