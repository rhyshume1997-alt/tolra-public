"use client";

/**
 * Module J: what Settings mounts for Document designs. It is a small closed card until the person opens it (or arrives on #setup-designs from the
 * company setup's "Logo and colours" step); only then is the real card (components/document-templates/document-designs-card) loaded, and only that
 * card reads the stored choices, loads the design list or builds a PDF preview. So an ordinary Settings visit does no document-template work at all,
 * whether or not the feature is switched on.
 * Inputs: none. Outputs: a closed card, then the real card. Must not change: it must stay free of imports that pull in the PDF code, the design
 * list or the database (the real card is imported lazily), and it must not touch Company details or any other Settings card.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { LayoutTemplate } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const DocumentDesignsCard = lazy(() => import("@/components/document-templates/document-designs-card").then((m) => ({ default: m.DocumentDesignsCard })));

export const DOCUMENT_DESIGNS_HASH = "#setup-designs";

function ClosedCard({ onOpen, loading }: { onOpen?: () => void; loading?: boolean }) {
  return (
    <Card id="setup-designs">
      <CardHeader><CardTitle className="flex items-center gap-2"><LayoutTemplate className="size-5" aria-hidden /> Document designs</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600">Choose how your quotes, invoices, purchase orders and delivery notes look, with a live preview. Off until you switch it on.</p>
        {loading ? <p>Loading…</p> : <Button variant="outline" onClick={onOpen}>Open document designs</Button>}
      </CardContent>
    </Card>
  );
}

export function DocumentDesignsSection() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => { if (window.location.hash === DOCUMENT_DESIGNS_HASH) setOpen(true); };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  if (!open) return <ClosedCard onOpen={() => setOpen(true)} />;
  return <Suspense fallback={<ClosedCard loading />}><DocumentDesignsCard /></Suspense>;
}
