"use client";

import { Building2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/friendly-error";
import { PRODUCT } from "@/lib/product";
import { supabase } from "@/lib/supabase";

type Company = { organization_id: string; name: string; slug: string; role: string; is_current: boolean };

/**
 * The company picker for a person who belongs to two or more companies. The list is the database's my_organizations(): only the
 * person's own companies, so no other company's name can appear here. Choosing one is switch_organization() for this sign-in only.
 */
export default function ChooseCompanyPage() {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logos, setLogos] = useState<Record<string, string | null>>({});

  const load = useCallback(async (isLive: () => boolean) => {
    if (!supabase) return setError("Sign-in isn't available right now. Please contact support.");
    try {
      const { data, error: listError } = await supabase.rpc("my_organizations");
      if (!isLive()) return;
      if (listError) return setError(friendlyError(listError, "Couldn't load your companies."));
      setCompanies((data ?? []) as Company[]);
      // Logos come after the cards, from our own route (the picker can't read other companies' folders itself). A failure is silent.
      void fetch("/api/my-company-logos", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: Record<string, string | null> | null) => { if (isLive() && body && typeof body === "object") setLogos(body); })
        .catch(() => undefined);
    } catch (err) {
      if (isLive()) setError(friendlyError(err, "Couldn't load your companies."));
    }
  }, []);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

  /** Only for a failed list load: clears the error and asks again. */
  function retry() {
    setError(null);
    setCompanies(null);
    void load(() => true);
  }

  async function choose(company: Company) {
    if (!supabase) return;
    setBusy(company.organization_id);
    setError(null);
    const { error: switchError } = await supabase.rpc("switch_organization", { p_org: company.organization_id });
    if (switchError) {
      setBusy(null);
      return setError(friendlyError(switchError, "Couldn't open that company."));
    }
    // The role view comes next for admins and people with two roles (it goes straight on to the dashboard for everyone else).
    window.location.assign("/select-role");
  }

  async function signOut() {
    try {
      await supabase?.auth.signOut();
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center text-center">
        <Badge className="bg-brand text-brand-ink">{PRODUCT.name}</Badge>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-950">Choose a company</h1>
        <p className="mt-3 max-w-xl text-slate-500">You have access to more than one company. Choose the one to work in. You can change it later from the menu.</p>

        {error ? <p role="alert" className="mt-6 rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700">{error}</p> : null}
        {error && companies === null ? <Button className="mt-4 min-h-11 bg-brand text-brand-ink hover:bg-brand-hover" onClick={retry}>Retry</Button> : null}

        <div className="mt-8 grid w-full gap-4 sm:grid-cols-2" data-testid="company-list">
          {companies === null && !error ? <><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></> : null}
          {(companies ?? []).map((company) => (
            <Card key={company.organization_id} className="border-slate-200 transition hover:border-brand-accent hover:shadow-md">
              <CardContent className="flex h-full flex-col p-6 text-left">
                {logos[company.organization_id] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a data: URL from our own route, so next/image has nothing to optimise
                  <img src={logos[company.organization_id] as string} alt={`${company.name} logo`} className="h-11 max-w-[160px] self-start object-contain" />
                ) : (
                  <div className="flex size-11 items-center justify-center rounded-xl bg-brand text-brand-ink"><Building2 className="size-5" /></div>
                )}
                <h2 className="mt-4 text-lg font-bold text-slate-950">{company.name}</h2>
                <p className="mt-1 flex-1 text-sm capitalize text-slate-500">{company.role}</p>
                <Button className="mt-5 min-h-11 w-full bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy !== null} onClick={() => void choose(company)} aria-label={`Open ${company.name}`}>
                  {busy === company.organization_id ? "Opening..." : "Open"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        {companies && !companies.length ? <p className="mt-6 text-slate-500">You don&apos;t have access to any company. Contact your administrator.</p> : null}

        <Button variant="ghost" className="mt-6 min-h-11 text-slate-500" onClick={() => void signOut()}>Sign out</Button>
      </div>
    </main>
  );
}
