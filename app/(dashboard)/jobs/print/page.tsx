"use client";

// Module 2 print entry: loads the selected jobs with their drawings and registered customer PO references for the existing workshop pack layouts. Layouts stay unchanged.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";

import type { BasicPackSheet } from "@/components/job-worksheet-basic-print";
import { PrintLayoutPicker, WorksheetPackInLayout } from "@/components/print-layout-picker";
import { Button } from "@/components/ui/button";
import { loadWorksheetCustomerPoNames } from "@/lib/job-files";
import { listDrawings, loadWorksheet } from "@/lib/job-worksheet";
import { printLayoutLabel, useCompanyPrintLayout } from "@/lib/print-layout";
import { type PrintOverride, packLayoutOf, resolvePrintChoice } from "@/lib/worksheet-builder/print-choice";
import { useWorksheetBuilder } from "@/lib/worksheet-builder/store";

/** Workshop pack: ONE worksheet sheet (same form as the single worksheet) with every selected job on it, a row each. */
function WorkshopPack() {
  const ids = (useSearchParams().get("ids") || "").split(",").filter(Boolean);
  const selection = ids.join(",");
  return <WorkshopPackSelection key={selection} selection={selection} />;
}

function WorkshopPackSelection({ selection }: { selection: string }) {
  const ids = selection.split(",").filter(Boolean);
  const [sheets, setSheets] = useState<BasicPackSheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The company's layout (Settings > Print layout), unless the person picks the other one for this print.
  const companyLayout = useCompanyPrintLayout();
  const [override, setOverride] = useState<PrintOverride>(null);
  // A company's own worksheet layout (module K) has no workshop-pack form: the pack prints in that layout's Basic or JNR base.
  const builder = useWorksheetBuilder();
  const choice = resolvePrintChoice({ company: companyLayout, override, builder });
  const layout = choice ? packLayoutOf(choice) : null;

  useEffect(() => {
    if (!selection) return;
    let active = true;
    async function load() {
      setError(null);
      setSheets(null);
      const jobIds = selection.split(",");
      const loaded = await Promise.all(jobIds.map(async (id) => {
        const result = await loadWorksheet({ id, job_no: "", customer: "", description: "" });
        if (result.error !== undefined) return { kind: "worksheet-error" as const };
        const stored = result.demo ? [] : await listDrawings(id);
        if (stored === null) return { kind: "drawings-unavailable" as const };
        const customerPos = result.demo ? [] : await loadWorksheetCustomerPoNames(id);
        if (customerPos === null) return { kind: "customer-pos-unavailable" as const };
        const sheet: BasicPackSheet = {
          id,
          customerPos,
          worksheet: result.worksheet,
          traceable: result.row?.traceable === true,
          drawings: stored.map((file) => (file.revision ? `${file.name} (Rev ${file.revision})` : file.name)),
        };
        return { kind: "ready" as const, sheet };
      }));
      if (!active) return;
      const failed = loaded.filter((result) => result.kind === "worksheet-error").length;
      if (failed) {
        setError(`Couldn't load ${failed} of ${jobIds.length} worksheet${jobIds.length === 1 ? "" : "s"}. Retry.`);
        return;
      }
      if (loaded.some((result) => result.kind === "drawings-unavailable")) {
        setError("Drawings unavailable for one or more selected jobs. Check your connection and try again.");
        return;
      }
      if (loaded.some((result) => result.kind === "customer-pos-unavailable")) {
        setError("Customer PO attachments unavailable for one or more selected jobs. Check your connection and try again.");
        return;
      }
      setSheets(loaded.flatMap((result) => result.kind === "ready" ? [result.sheet] : []));
    }
    void load();
    return () => { active = false; };
  }, [selection, attempt]);

  if (!selection) return <p className="mx-auto w-[297mm] max-w-full text-sm text-slate-500">No jobs selected. Select jobs on the Jobs page, then Print Workshop Pack.</p>;

  return (
    <>
      <div className="no-print mx-auto mb-4 flex w-[297mm] max-w-full items-center justify-between">
        <p className="text-sm text-slate-500">Workshop pack: {ids.length} job{ids.length === 1 ? "" : "s"} on one A4 landscape worksheet.</p>
        <div className="flex items-center gap-3">
          <PrintLayoutPicker company={companyLayout} value={override} onChange={setOverride} companyLabel={choice?.kind === "custom" && !override ? `Company setting (${printLayoutLabel(packLayoutOf(choice))}, from ${choice.layout.name})` : undefined} />
          <Button className="bg-[#1E3472] text-white" disabled={!sheets || !layout} onClick={() => window.print()}><Printer className="size-4" /> Print Now</Button>
        </div>
      </div>
      {error ? (
        <div className="no-print mx-auto flex w-[297mm] max-w-full items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <span>{error}</span>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : sheets && layout ? (
        <WorksheetPackInLayout layout={layout} sheets={sheets} />
      ) : (
        <p className="text-sm text-slate-500">Loading worksheets...</p>
      )}
    </>
  );
}

export default function WorkshopPackPage() {
  return (
    <div className="bg-white p-4 text-black print:p-0">
      <style>{`
        @media print {
          aside, header, nav, .no-print { display:none!important; }
          html, body { background:white!important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
          @page { size:A4 landscape; margin:8mm; }
          * { box-shadow:none!important; }
        }
      `}</style>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading worksheets...</p>}>
        <WorkshopPack />
      </Suspense>
    </div>
  );
}
