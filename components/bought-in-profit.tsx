"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { databaseHas124 } from "@/lib/db-features";
import { DEMO_MODE } from "@/lib/demo";
import { type LinkedPo, type Profit, type SellLine, boughtIn, boughtInText, invoicedSellPence, profitOf, profitText, quoteSellPence } from "@/lib/purchase-order-link";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const OFFICE = new Set(["admin", "office"]);

/**
 * The small "Bought in" + "Profit" line on a quote's details and on a job's worksheet (migration 124): what was bought from suppliers for it
 * (the linked supplier purchase orders) and sell minus buy, ex VAT (lib/purchase-order-link.ts has the rule). Office and admin only: for
 * workshop and viewer nothing is rendered and nothing is read. Hidden until 124 is applied. "Raise supplier PO" opens a new purchase order
 * already linked to this quote or job (one click, optional).
 */
export function BoughtInProfit({ kind, id, quoteLines }: {
  kind: "quote" | "job";
  id: string | undefined;
  /** The quote's lines as the details dialog already holds them (kind "quote"). */
  quoteLines?: SellLine[];
}) {
  const { activeRole } = useUser();
  const office = OFFICE.has(activeRole) && !DEMO_MODE;
  const [has124, setHas124] = useState(false);
  const [profit, setProfit] = useState<Profit | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const linesKey = JSON.stringify(quoteLines ?? null);

  useEffect(() => {
    if (!office) return;
    let active = true;
    void databaseHas124().then((present) => { if (active) setHas124(present); });
    return () => { active = false; };
  }, [office]);

  useEffect(() => {
    if (!office || !has124 || !id || !supabase || id.startsWith("demo")) return;
    const db = supabase;
    let active = true;
    setFailed(false);
    void (async () => {
      try {
        let quoteId: string | null = kind === "quote" ? id : null;
        let jobIds: string[] = kind === "job" ? [id] : [];
        if (kind === "quote") {
          const jobs = await db.from("jobs").select("id").eq("quote_id", id);
          if (jobs.error) throw jobs.error;
          jobIds = (jobs.data ?? []).map((row) => String(row.id));
        } else {
          const job = await db.from("jobs").select("quote_id").eq("id", id).maybeSingle();
          if (job.error) throw job.error;
          quoteId = job.data?.quote_id ? String(job.data.quote_id) : null;
        }
        // The orders linked to the quote or to its job(s): each counted once.
        const or = [quoteId ? `quote_id.eq.${quoteId}` : "", jobIds.length ? `job_id.in.(${jobIds.join(",")})` : ""].filter(Boolean).join(",");
        const pos = or ? await db.from("purchase_orders").select("id, po_ref, po_number, status, total_value, linked_net").or(or) : { data: [], error: null };
        if (pos.error) throw pos.error;
        const linked = (pos.data ?? []) as (LinkedPo & { po_ref?: string | null; po_number?: string | null })[];
        const buy = boughtIn(linked);

        let sell: number | null = null;
        let basis: Profit["basis"] = "none";
        if (kind === "job") {
          const invoices = await db.from("invoices").select("id, status, subtotal").eq("job_id", id);
          if (invoices.error) throw invoices.error;
          const invoiceIds = (invoices.data ?? []).map((row) => String(row.id));
          const credits = invoiceIds.length ? await db.from("credit_notes").select("invoice_id, status, subtotal").in("invoice_id", invoiceIds) : { data: [], error: null };
          if (credits.error) throw credits.error;
          sell = invoicedSellPence((invoices.data ?? []).map((row) => ({ ...row, id: String(row.id) })), credits.data ?? []);
          if (sell !== null) basis = "invoiced";
        }
        if (sell === null && kind === "quote" && quoteLines) {
          sell = quoteSellPence(quoteLines);
          basis = "quote";
        } else if (sell === null && quoteId) {
          const lines = await db.from("quote_line_items").select("quantity, unit_price, declined").eq("quote_id", quoteId);
          if (lines.error) throw lines.error;
          sell = quoteSellPence(lines.data ?? []);
          basis = "quote";
        }
        if (!active) return;
        setProfit(profitOf(sell, buy, basis));
        setRefs(linked.filter((po) => String(po.status ?? "").toLowerCase() !== "cancelled").map((po) => String(po.po_ref || po.po_number || "")).filter(Boolean));
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => { active = false; };
    // linesKey stands for quoteLines (a new array each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [office, has124, id, kind, linesKey]);

  if (!office || !has124 || !id || id.startsWith("demo")) return null;
  const loss = (profit?.profitPence ?? 0) < 0;
  return (
    <div data-testid="bought-in-profit" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm">
      {failed ? <span className="text-slate-600">Couldn&apos;t work out what was bought in.</span> : profit ? (
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span data-testid="bought-in" title={refs.length ? refs.join(", ") : undefined}>{boughtInText(profit)}</span>
          <span data-testid="profit" className={loss ? "font-semibold text-red-700 dark:text-red-300" : "font-semibold text-slate-950"}>{profitText(profit)}</span>
          <span className="text-xs text-slate-500">ex VAT{profit.basis === "invoiced" ? ", sell as invoiced less credit notes" : profit.basis === "quote" ? ", sell as quoted" : ""}</span>
        </span>
      ) : <span className="text-slate-500">Working out what was bought in…</span>}
      <Link data-testid="raise-supplier-po" href={`/purchase-orders?new=${kind}:${encodeURIComponent(id)}`} className="text-sm font-medium underline">Raise supplier PO</Link>
    </div>
  );
}
