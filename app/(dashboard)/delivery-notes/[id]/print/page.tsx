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
import { deliveryNoteReceivedLine } from "@/lib/delivery-note-print";
import { deliveryNoteInspectionLine } from "@/lib/inspection";
import { supabase } from "@/lib/supabase";
import { PrintLogo } from "@/components/print-logo";

type PrintNote = {
  ref: string;
  customer: string;
  job: string;
  status: string;
  date: string;
  taxDate: string;
  shipVia: string;
  items: Array<{ description: string; quantity: number }>;
  /** 081: "Inspected/checked by <name>, <date>" from the job's latest pass or concession; never whether it was independent. */
  inspected?: string | null;
  /** Who signed for the goods and when (a note recorded as signed). */
  signedByName?: string | null;
  signedAt?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadNote(id: string): Promise<PrintNote | null> {
  if (!UUID.test(id)) {
    // Only demo rows have non-UUID ids (their reference).
    if (!DEMO_MODE) return null;
    const m = await import("@/lib/jnr-test-data");
    const note = m.JNR_TEST_DELIVERY_NOTES.find((item) => item.ref === id);
    return note ? { ref: note.ref, customer: note.customer, job: note.jobNo, status: note.status, date: note.shipDate, taxDate: note.taxDate, shipVia: note.shipVia, items: note.items } : null;
  }
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.from("delivery_notes").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: items, error: itemsError } = await supabase.from("delivery_note_items").select("description, quantity").eq("delivery_note_id", id).order("position");
  if (itemsError) throw itemsError;
  // Only the inspector's name, the date and the result are read: never the independence flag, criteria or measurements.
  const inspection = data.job_id
    ? (await supabase.from("job_inspections").select("inspector_name, inspected_at, result").eq("job_id", data.job_id).in("result", ["pass", "concession"]).order("inspected_at", { ascending: false }).limit(1).maybeSingle()).data
    : null;
  return {
    inspected: deliveryNoteInspectionLine(inspection ?? undefined, fmtDate),
    ref: data.dn_number || data.dn_ref || `DN-${String(data.id).slice(0, 8)}`,
    customer: data.customer || "",
    job: data.job_ref || "",
    status: data.status || "pending",
    date: data.delivery_date || data.ship_date || data.created_at || "",
    taxDate: data.tax_date || "",
    shipVia: data.ship_via || "",
    signedByName: data.signed_by_name ?? null,
    signedAt: data.signed_at ?? null,
    items: (items ?? []).map((row) => ({ description: String(row.description || ""), quantity: Number(row.quantity || 0) })),
  };
}

export default function PrintDeliveryNotePage() {
  const params = useParams<{ id: string }>();
  const { profile: company, loading: companyLoading } = useCompanyProfile();
  const [note, setNote] = useState<PrintNote | null>(null);
  const [address, setAddress] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const loaded = await loadNote(decodeURIComponent(params.id));
        if (cancelled) return;
        setNote(loaded);
        if (loaded) {
          const lines = await resolveCustomerAddress(loaded.customer);
          if (!cancelled) setAddress(lines);
        }
      } catch (err) {
        if (!cancelled) setError(friendlyError(err, "Couldn't load this delivery note."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [params.id]);

  if (loading || companyLoading) return <div className="mx-auto max-w-3xl space-y-4 p-8"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  if (!company) return <div className="mx-auto max-w-3xl p-8 text-sm text-red-700" role="alert">Company details aren&apos;t set up — ask an admin to add them in Settings.</div>;
  if (error) return <div className="mx-auto max-w-3xl p-8 text-sm text-red-700" role="alert">{error}</div>;
  if (!note) return <div className="mx-auto max-w-3xl p-8 text-sm text-slate-600">Delivery note not found.</div>;

  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-slate-950 print:p-0">
      <style>{`@media print { aside, header, .no-print { display:none!important; } body { background:white!important; } @page { size:A4; margin:18mm; } }`}</style>
      <Button className="no-print mb-6 bg-[#1E3472] text-white" onClick={() => window.print()}>Print Now</Button>
      <div className="flex items-start justify-between gap-6 border-b pb-4"><div><h1 className="text-3xl font-bold">{company.name}</h1><p>{[...company.addressLines, `VAT ${company.vatNumber}`].join(", ")}</p><p>Delivery Note {note.ref}</p></div><PrintLogo company={company} /></div>
      <h2 className="my-8 text-center text-4xl font-bold">DELIVERY NOTE</h2>
      <div className="grid grid-cols-2 gap-6 text-sm">
        <div><p><strong>Customer:</strong> {note.customer}</p>{address.slice(1).map((line, index) => <p key={`${line}-${index}`}>{line}</p>)}</div>
        <div className="space-y-1"><p><strong>Delivery Date:</strong> {fmtDate(note.date)}</p>{note.taxDate ? <p><strong>Tax Date:</strong> {fmtDate(note.taxDate)}</p> : null}<p><strong>Job Ref:</strong> {note.job || "No linked job"}</p>{note.inspected ? <p data-testid="dn-inspected">{note.inspected}</p> : null}{note.shipVia ? <p><strong>Ship Via:</strong> {note.shipVia}</p> : null}<p><strong>Status:</strong> <span className="capitalize">{note.status}</span></p></div>
      </div>
      <table className="mt-8 w-full border-collapse text-sm"><thead><tr><th className="border p-2 text-left">Item</th><th className="border p-2">Qty</th></tr></thead><tbody>{note.items.length ? note.items.map((item, index) => <tr key={`${item.description}-${index}`}><td className="border p-2 whitespace-pre-line">{item.description}</td><td className="border p-2 text-center">{item.quantity}</td></tr>) : <tr><td className="border p-2 text-slate-500" colSpan={2}>No items recorded.</td></tr>}</tbody></table>
      <p className="mt-10" data-testid="dn-received">{deliveryNoteReceivedLine(note, fmtDate)}</p>
    </div>
  );
}
