"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCompanyProfile } from "@/lib/company";
import { resolveCustomerAddress } from "@/lib/customers";
import { DEMO_MODE } from "@/lib/demo";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { documentTotals, gbp } from "@/lib/money";
import { supabase } from "@/lib/supabase";
import { PrintLogo } from "@/components/print-logo";

type PrintOrder = { ref: string; customer: string; quoteRef: string; orderDate: string; delivery: string; value: number; status: string; vatEnabled?: boolean; vatPct?: number; vatExempt?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadOrder(id: string): Promise<PrintOrder | null> {
  if (!UUID.test(id)) {
    // Only demo rows are addressed by their reference.
    if (!DEMO_MODE) return null;
    const m = await import("@/lib/jnr-test-data");
    const order = m.JNR_TEST_SALES_ORDERS.find((item) => item.ref === id);
    return order ? { ref: order.ref, customer: order.customer, quoteRef: order.quoteRef, orderDate: order.orderDate, delivery: order.dueDate, value: order.value, status: order.status } : null;
  }
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.from("sales_orders").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ref: data.customer_po || data.so_number || `SO-${String(data.id).slice(0, 8)}`,
    customer: data.customer || "",
    quoteRef: data.quote_ref || "",
    orderDate: data.order_date || "",
    delivery: data.delivery_date || data.expected_delivery || "",
    value: Number(data.total_value || 0),
    vatEnabled: data.vat_enabled === true,
    vatPct: data.vat_pct === null || data.vat_pct === undefined ? undefined : Number(data.vat_pct),
    vatExempt: Boolean(data.vat_exempt),
    status: data.status || "open",
  };
}

export default function SalesOrderPrintPage() {
  const params = useParams<{ id: string }>();
  const { profile: company, loading: companyLoading } = useCompanyProfile();
  const [order, setOrder] = useState<PrintOrder | null>(null);
  const [address, setAddress] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const loaded = await loadOrder(decodeURIComponent(params.id));
        if (cancelled) return;
        setOrder(loaded);
        if (loaded) {
          const lines = await resolveCustomerAddress(loaded.customer);
          if (!cancelled) setAddress(lines);
        }
      } catch (err) {
        if (!cancelled) setError(friendlyError(err, "Couldn't load this sales order."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [params.id]);

  // Open the print dialog once there is something real to print.
  const ready = Boolean(order && company);
  useEffect(() => {
    if (!ready) return;
    const timeout = window.setTimeout(() => window.print(), 500);
    return () => window.clearTimeout(timeout);
  }, [ready]);

  if (loading || companyLoading) return <div className="mx-auto max-w-3xl space-y-4 p-8"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  if (!company) return <div className="mx-auto max-w-3xl p-8 text-sm text-red-700" role="alert">Company details aren&apos;t set up — ask an admin to add them in Settings.</div>;
  if (error) return <div className="mx-auto max-w-3xl p-8 text-sm text-red-700" role="alert">{error}</div>;
  if (!order) return <div className="mx-auto max-w-3xl p-8 text-sm text-slate-600">Sales order not found.</div>;
  const vatOn = Boolean(order.vatEnabled) && company.vatRegistered !== false;
  const standardRate = company.defaultVatRate ?? 20;
  const totals = documentTotals([{ quantity: 1, unitPrice: order.value, vatPct: order.vatPct, vatExempt: order.vatExempt }], 0, { vatEnabled: vatOn, standardRate });

  return (
    <main className="mx-auto max-w-3xl bg-white p-8 text-slate-950 print:p-0">
      <style>{`@media print { .no-print { display:none!important; } body { background:white!important; } @page { size:A4; margin:18mm; } }`}</style>
      <Button className="no-print mb-6 bg-[#1E3472] text-white" onClick={() => window.print()}>Print Now</Button>
      <header className="flex items-start justify-between gap-6 border-b-2 border-[#1E3472] pb-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1E3472]">{company.name}</h1>
          <p className="text-sm text-slate-600">{[...company.addressLines, company.email].filter(Boolean).join(" | ")}</p>
        </div>
        <PrintLogo company={company} />
      </header>
      <section className="mt-8">
        <h2 className="text-center text-3xl font-bold tracking-wide">SALES ORDER</h2>
        <p className="mt-3 text-center font-mono text-lg">{order.ref}</p>
      </section>
      <table className="mt-8 w-full border-collapse text-sm">
        <tbody>
          <tr><th className="border p-3 text-left">Customer</th><td className="border p-3">{[order.customer, ...address.slice(1)].filter(Boolean).join(", ")}</td></tr>
          <tr><th className="border p-3 text-left">Order Date</th><td className="border p-3">{fmtDate(order.orderDate) || "-"}</td></tr>
          <tr><th className="border p-3 text-left">Expected Delivery</th><td className="border p-3">{fmtDate(order.delivery) || "Not set"}</td></tr>
          {order.quoteRef ? <tr><th className="border p-3 text-left">Our Quote No.</th><td className="border p-3">{order.quoteRef}</td></tr> : null}
          <tr><th className="border p-3 text-left">Order Value (ex VAT)</th><td className="border p-3">{gbp(order.value)}</td></tr>
          {vatOn ? (
            <>
              <tr><th className="border p-3 text-left">{order.vatExempt ? "VAT (exempt)" : `VAT ${order.vatPct ?? standardRate}%`}</th><td className="border p-3">{gbp(totals.vat)}</td></tr>
              <tr><th className="border p-3 text-left">Order Total</th><td className="border p-3 font-semibold">{gbp(totals.total)}</td></tr>
            </>
          ) : null}
          <tr><th className="border p-3 text-left">Status</th><td className="border p-3 capitalize">{order.status.replaceAll("_", " ")}</td></tr>
        </tbody>
      </table>
      <footer className="mt-16 grid grid-cols-2 gap-8 text-sm">
        <p>Authorised by: __________________</p>
        <p>Date: __________________</p>
      </footer>
    </main>
  );
}
