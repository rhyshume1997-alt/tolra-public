"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";

import type { PackSheet } from "@/components/job-worksheet-pack-print";
import { PrintLayoutPicker, WorksheetPackInLayout } from "@/components/print-layout-picker";
import { Button } from "@/components/ui/button";
import { listDrawings, loadWorksheet } from "@/lib/job-worksheet";
import { type PrintLayout, chosenPrintLayout, useCompanyPrintLayout } from "@/lib/print-layout";

/** Workshop pack: ONE worksheet sheet (same form as the single worksheet) with every selected job on it, a row each. */
function WorkshopPack() {
  const ids = (useSearchParams().get("ids") || "").split(",").filter(Boolean);
  const key = ids.join(",");
  const [sheets, setSheets] = useState<PackSheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The company's layout (Settings > Print layout), unless the person picks the other one for this print.
  const companyLayout = useCompanyPrintLayout();
  const [override, setOverride] = useState<PrintLayout | null>(null);
  const layout = chosenPrintLayout(companyLayout, override);

  const load = useCallback(async () => {
    setError(null);
    setSheets(null);
    const jobIds = key.split(",").filter(Boolean);
    const loaded = await Promise.all(jobIds.map(async (id) => {
      const result = await loadWorksheet({ id, job_no: "", customer: "", description: "" });
      if (result.error !== undefined) return { id, error: result.error };
      const stored = result.demo ? null : await listDrawings(id);
      return { id, worksheet: result.worksheet, drawings: stored ? stored.map((file) => (file.revision ? `${file.name} (Rev ${file.revision})` : file.name)) : [] };
    }));
    const failed = loaded.filter((sheet) => "error" in sheet).length;
    if (failed) {
      setError(`Couldn't load ${failed} of ${jobIds.length} worksheet${jobIds.length === 1 ? "" : "s"}. Retry.`);
      return;
    }
    setSheets(loaded as PackSheet[]);
  }, [key]);

  useEffect(() => {
    if (key) void load();
  }, [load, key, attempt]);

  if (!key) return <p className="mx-auto w-[297mm] max-w-full text-sm text-slate-500">No jobs selected. Select jobs on the Jobs page, then Print Workshop Pack.</p>;

  return (
    <>
      <div className="no-print mx-auto mb-4 flex w-[297mm] max-w-full items-center justify-between">
        <p className="text-sm text-slate-500">Workshop pack: {ids.length} job{ids.length === 1 ? "" : "s"} on one A4 landscape worksheet.</p>
        <div className="flex items-center gap-3">
          <PrintLayoutPicker company={companyLayout} value={override} onChange={setOverride} />
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
