"use client";

/** Numbers route state and read-only queries, shared by both layouts. The active admin role controls queries and redirects. */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAll } from "@/lib/fetch-all";
import {
  cashByMonth,
  customerConcentration,
  invoicedByMonth,
  londonMonthsEnding,
  machineHours,
  receivedByMonth,
  sumOrNull,
  windowOf,
  type NumberCredit,
  type NumberInvoice,
  type NumberMachine,
  type NumberPayment,
  type NumberRun,
} from "@/lib/numbers";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

export const MONTH_CHOICES = [3, 6, 12] as const;
export const SHOWN_CUSTOMERS = 8;

type Read<T> = { rows: T[] } | { failed: true };
type Loaded = {
  now: Date;
  invoices: Read<NumberInvoice>;
  credits: Read<NumberCredit>;
  payments: Read<NumberPayment>;
  machines: Read<NumberMachine>;
  runs: Read<NumberRun>;
};

const iso = (ms: string) => ms.replace(".000Z", "Z");

/** One list, every row of it (page by page); a failed or cut-short read is a failure, never a smaller list. */
async function readAll<T extends Record<string, unknown>>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<Read<T>> {
  try {
    const { rows, truncated } = await fetchAll<T>(page);
    return truncated ? { failed: true } : { rows };
  } catch {
    return { failed: true };
  }
}

async function loadNumbers(months: number): Promise<Loaded> {
  const db = supabase;
  const now = new Date();
  if (!db) {
    const failed = { failed: true } as const;
    return { now, invoices: failed, credits: failed, payments: failed, machines: failed, runs: failed };
  }
  const w = windowOf(londonMonthsEnding(now, months));
  const startAt = iso(w.startAt);
  const endAt = iso(w.endAt);
  const [invoices, credits, payments, machines, runs] = await Promise.all([
    // An invoice counts on its invoice date, else the day it was made (London): the window is applied to whichever it has.
    readAll<NumberInvoice & Record<string, unknown>>((from, to) => db.from("invoices").select("id, customer, status, subtotal, vat, carriage, total, invoice_date, created_at")
      .or(`invoice_date.gte.${w.start},and(invoice_date.is.null,created_at.gte.${startAt})`)
      .or(`invoice_date.lt.${w.end},and(invoice_date.is.null,created_at.lt.${endAt})`)
      .order("id").range(from, to)),
    readAll<NumberCredit & Record<string, unknown>>((from, to) => db.from("credit_notes").select("id, customer, status, vat, total, credit_date").eq("status", "issued").gte("credit_date", w.start).lt("credit_date", w.end).order("id").range(from, to)),
    readAll<NumberPayment & Record<string, unknown>>((from, to) => db.from("invoice_payments").select("id, amount, paid_on").gte("paid_on", w.start).lt("paid_on", w.end).order("id").range(from, to)),
    readAll<NumberMachine & Record<string, unknown>>((from, to) => db.from("machines").select("id, name").order("id").range(from, to)),
    // Runs that touch the window: started before it ends, and either still going or ended after it starts.
    readAll<NumberRun & Record<string, unknown>>((from, to) => db.from("machine_runs").select("id, machine_id, started_at, ended_at")
      .lt("started_at", endAt).or(`ended_at.is.null,ended_at.gt.${startAt}`).order("id").range(from, to)),
  ]);
  return { now, invoices, credits, payments, machines, runs };
}

const rowsOf = <T,>(read: Read<T>): T[] | null => ("rows" in read ? read.rows : null);

export function useNumbersView() {
  const router = useRouter();
  const { activeRole, loading: userLoading } = useUser();
  const admin = !userLoading && activeRole === "admin";
  const [months, setMonths] = useState<number>(6);
  const [data, setData] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // The middleware already turns a real non-admin away; this covers an admin working in another role's view.
  useEffect(() => {
    if (!userLoading && activeRole !== "admin") router.replace("/dashboard");
  }, [userLoading, activeRole, router]);

  useEffect(() => {
    if (!admin) return;
    const ticket = ++latest.current;
    setData(null);
    void loadNumbers(months).then((result) => {
      if (latest.current === ticket) setData(result);
    });
  }, [admin, months, attempt]);

  const periods = useMemo(() => londonMonthsEnding(data?.now ?? new Date(), months), [data?.now, months]);
  const view = useMemo(() => {
    if (!data) return null;
    const invoices = rowsOf(data.invoices);
    const credits = rowsOf(data.credits);
    const payments = rowsOf(data.payments);
    const machines = rowsOf(data.machines);
    const runs = rowsOf(data.runs);
    const w = windowOf(periods);
    const invoiced = invoices && credits ? invoicedByMonth(invoices, credits, periods) : null;
    const received = payments ? receivedByMonth(payments, periods) : null;
    const cash = cashByMonth(periods, invoiced, received);
    return {
      cash,
      invoicedTotal: invoiced ? sumOrNull(cash.map((m) => m.invoiced)) : null,
      receivedTotal: received ? sumOrNull(cash.map((m) => m.received)) : null,
      invoicedRead: Boolean(invoiced),
      receivedRead: Boolean(received),
      customers: invoices && credits ? customerConcentration(invoices, credits, w) : undefined,
      machines: machines && runs ? machineHours(runs, machines, w, data.now) : null,
    };
  }, [data, periods]);
  const customers = view?.customers;
  const customerRows = customers
    ? [
        ...customers.rows.slice(0, SHOWN_CUSTOMERS).map((row) => ({ key: row.customer, label: `${row.customer} · ${row.share}%`, value: row.value })),
        ...(customers.rows.length > SHOWN_CUSTOMERS
          ? [{ key: "others", label: `${customers.rows.length - SHOWN_CUSTOMERS} other customers`, value: customers.rows.slice(SHOWN_CUSTOMERS).reduce((sum, row) => sum + row.value, 0) }]
          : []),
      ]
    : [];
  const anyCash = view?.cash.some((m) => m.invoiced !== null || m.received !== null);
  const span = `Last ${months} months, ${periods[0].label} to ${periods[periods.length - 1].label}`;

  return { admin, months, setMonths, retry, view, customers, customerRows, anyCash, span };
}

export type NumbersScreen = ReturnType<typeof useNumbersView>;
