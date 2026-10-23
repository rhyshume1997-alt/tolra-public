"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Printer } from "lucide-react";

import { JobWorksheetPrint } from "@/components/job-worksheet-print";
import { listCustomerPos } from "@/lib/job-files";
import { Button } from "@/components/ui/button";
import { DEMO_MODE } from "@/lib/demo";
import { type JobWorksheet, type WorksheetJobInfo, listDrawings, loadWorksheet } from "@/lib/job-worksheet";

type DemoJob = Omit<WorksheetJobInfo, "id"> & { drawings: string[] };

const simpleDemoJobs: Record<string, DemoJob> = {
  "1": { job_no: "JNR-J-218", customer: "Aerospace Components", description: "Titanium brackets", drawings: ["ACL-BRACKET-REV3.pdf", "MATERIAL-SPEC-TI-G5.pdf"] },
  "2": { job_no: "JNR-J-219", customer: "Industrial Systems", description: "Aluminium plates", drawings: ["ISL-PLATE-2026-04.pdf"] },
  "3": { job_no: "JNR-J-220", customer: "Precision Engineering", description: "SS shafts", drawings: ["PEG-SHAFT-316.pdf"] },
};

/** Sample job details are only ever built in DEMO_MODE; real data comes from the database. */
async function demoJobInfo(id: string): Promise<DemoJob> {
  if (!DEMO_MODE) return { job_no: "", customer: "", description: "", drawings: [] };
  const { JNR_TEST_JOBS } = await import("@/lib/jnr-test-data");
  const job = JNR_TEST_JOBS.find((item) => item.id === id);
  if (job) {
    return {
      job_no: job.jobNo, customer: job.customer, description: job.description, drawings: [], customer_po: job.customerPo, date_received: job.dateReceived,
      date_required: job.dateRequired, quote_ref: job.quoteRef, quantity_required: job.quantityRequired, drawing_no: job.drawingNo,
    };
  }
  return simpleDemoJobs[id] || { job_no: `JOB-${String(id).slice(0, 8)}`, customer: "", description: "", drawings: [] };
}

export default function JobSheetPrintPage() {
  const { id } = useParams<{ id: string }>();
  const [worksheet, setWorksheet] = useState<JobWorksheet | null>(null);
  const [drawings, setDrawings] = useState<string[]>([]);
  const [customerPos, setCustomerPos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    setWorksheet(null);
    const demo = await demoJobInfo(id);
    const loaded = await loadWorksheet({ id, ...demo });
    if (loaded.error !== undefined) {
      setError(loaded.error);
      return;
    }
    setWorksheet(loaded.worksheet);
    const stored = loaded.demo ? null : await listDrawings(id);
    setDrawings(stored ? stored.map((file) => (file.revision ? `${file.name} (Rev ${file.revision})` : file.name)) : demo.drawings);
    setCustomerPos(loaded.demo ? [] : (await listCustomerPos(id).catch(() => [])).map((file) => file.file_name));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  return (
    <div className="bg-white p-4 text-black print:p-0">
      <style>{`
        @media print {
          aside, header, nav, .no-print { display:none!important; }
          html, body { background:white!important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
          @page { size:A4 portrait; margin:10mm; }
          * { box-shadow:none!important; }
        }
      `}</style>
      <div className="no-print mx-auto mb-4 flex w-[210mm] max-w-full items-center justify-between">
        <p className="text-sm text-slate-500">A4 portrait worksheet. Blank cells are left for handwriting.</p>
        <Button className="bg-[#1E3472] text-white" disabled={!worksheet} onClick={() => window.print()}><Printer className="size-4" /> Print Now</Button>
      </div>
      {error ? (
        <div className="no-print mx-auto flex w-[210mm] max-w-full items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <span>{error}</span>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : worksheet ? (
        <JobWorksheetPrint worksheet={worksheet} jobNo={worksheet.job_no} drawings={drawings} customerPos={customerPos} />
      ) : (
        <p className="text-sm text-slate-500">Loading worksheet...</p>
      )}
    </div>
  );
}
