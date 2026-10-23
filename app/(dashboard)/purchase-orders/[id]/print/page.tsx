"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompanyProfile } from "@/lib/company";
import { DEMO_MODE } from "@/lib/demo";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { documentTotals, gbp, vatRowLabel } from "@/lib/money";
import { vatColumnText } from "@/lib/vat";
import { supabase } from "@/lib/supabase";
import { PrintLogo } from "@/components/print-logo";

type PrintPo = {
  ref: string;
  supplier: string;
  date: string;
  delivery: string;
  status: string;
  value: number;
  notes: string;
  vatEnabled: boolean;
  items: Array<{ description: string; quantity: number; unitPrice: number; vatPct?: number; vatExempt?: boolean }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadPo(id: string): Promise<PrintPo | null> {
  // Purchase order ids are UUID strings. Anything else is a demo row, which has no stored record to print.
  if (!UUID.test(id)) return null;
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const items = (Array.isArray(data.items) ? data.items : []) as Array<{ description?: string; qty?: number; unit_price?: number; vat_pct?: number; vat_exempt?: boolean }>;
  return {
    ref: data.po_ref || data.po_number || `PO-${String(data.id).slice(0, 8)}`,
    supplier: data.supplier || "",
    date: data.order_date || "",
    delivery: data.expected_delivery || "",
    status: data.status || "sent",
    value: Number(data.total_value || 0),
    notes: data.notes || "",
    vatEnabled: data.vat_enabled === true,
    items: items.filter((item) => item.description).map((item) => ({ description: String(item.description), quantity: Number(item.qty || 1), unitPrice: Number(item.unit_price || 0), vatPct: item.vat_pct === undefined ? undefined : Number(item.vat_pct), vatExempt: Boolean(item.vat_exempt) })),
  };
}

export default function PrintPurchaseOrderPage() {
  const params = useParams<{ id: string }>();
  const { profile: company, loading: companyLoading } = useCompanyProfile();
  const [po, setPo] = useState<PrintPo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPo(decodeURIComponent(params.id))
      .then((loaded) => { if (!cancelled) setPo(loaded); })
      .catch((err) => { if (!cancelled) setError(friendlyError(err, "Couldn't load this purchase order.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [params.id]);

  if (loading || companyLoading) return <div className="mx-auto max-w-3xl space-y-4 p-8"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  if (!company) return <div className="mx-auto max-w-3xl p-8 text-sm text-red-700" role="alert">Company details aren&apos;t set up — ask an admin to add them in Settings.</div>;
  if (error) return <div className="mx-auto max-w-3xl p-8 text-sm text-red-700" role="alert">{error}</div>;
  if (!po) return <div className="mx-auto max-w-3xl p-8 text-sm text-slate-600">{DEMO_MODE ? "Demo purchase orders can't be printed. Create a real one first." : "Purchase order not found."}</div>;

  const items = po.items.length ? po.items : [{ description: `Materials ordered from ${po.supplier}`, quantity: 1, unitPrice: po.value }];
  const vatOn = po.vatEnabled && company.vatRegistered !== false;
  const standardRate = company.defaultVatRate ?? 20;
  const totals = documentTotals(items, 0, { vatEnabled: vatOn, standardRate });
  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-slate-950 print:p-0">
      <style>{`@media print { aside, header, .no-print { display:none!important; } body { background:white!important; } @page { size:A4; margin:18mm; } }`}</style>
      <Button className="no-print mb-6 bg-[#1E3472] text-white" onClick={() => window.print()}>Print Now</Button>
      <div className="flex items-start justify-between gap-6 border-b pb-4"><div><h1 className="text-3xl font-bold">{company.name}</h1><p>{[...company.addressLines, company.vatRegistered !== false && company.vatNumber ? `VAT ${company.vatNumber}` : ""].filter(Boolean).join(", ")}</p><p>Purchase Order {po.ref}</p></div><PrintLogo company={company} /></div>
      <h2 className="my-8 text-center text-4xl font-bold">PURCHASE ORDER</h2>
      <div className="grid grid-cols-2 gap-6 text-sm"><p><strong>Supplier:</strong> {po.supplier}</p><p><strong>Order Date:</strong> {fmtDate(po.date)}</p><p><strong>Expected Delivery:</strong> {fmtDate(po.delivery) || "Not set"}</p><p><strong>Status:</strong> <span className="capitalize">{po.status}</span></p></div>
      <table className="mt-8 w-full border-collapse text-sm">
        <thead><tr><th className="border p-2 text-left">Item</th><th className="border p-2">Qty</th><th className="border p-2">Unit (ex VAT)</th>{vatOn ? <th className="border p-2">VAT</th> : null}<th className="border p-2">Total</th></tr></thead>
        <tbody>{items.map((item, index) => <tr key={`${item.description}-${index}`}><td className="border p-2 whitespace-pre-line">{item.description}</td><td className="border p-2 text-center">{item.quantity}</td><td className="border p-2 text-center">{gbp(item.unitPrice)}</td>{vatOn ? <td className="border p-2 text-center">{vatColumnText(item.vatPct, item.vatExempt, standardRate)}</td> : null}<td className="border p-2 text-center">{gbp(documentTotals([{ quantity: item.quantity, unitPrice: item.unitPrice, vatPct: 0 }]).subtotal)}</td></tr>)}</tbody>
        <tfoot>
          <tr><td className="border p-2 text-right" colSpan={vatOn ? 4 : 3}>Subtotal (ex VAT)</td><td className="border p-2 text-center">{gbp(totals.subtotal)}</td></tr>
          {vatOn ? totals.vatBreakdown.filter((row) => !row.exempt).map((row) => (
            <tr key={vatRowLabel(row)}><td className="border p-2 text-right" colSpan={4}>{vatRowLabel(row)}</td><td className="border p-2 text-center">{gbp(row.vat)}</td></tr>
          )) : null}
          <tr><td className="border p-2 text-right font-semibold" colSpan={vatOn ? 4 : 3}>{vatOn ? "Total" : "Total (ex VAT)"}</td><td className="border p-2 text-center font-semibold">{gbp(totals.total)}</td></tr>
        </tfoot>
      </table>
      {po.notes ? <p className="mt-6 whitespace-pre-wrap text-sm"><strong>Notes:</strong> {po.notes}</p> : null}
      <p className="mt-10">Authorised by: __________________ Date: __________</p>
    </div>
  );
}
