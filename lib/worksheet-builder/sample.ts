/**
 * Module K (worksheet builder): the sample job the Settings live preview prints. Fixed, invented data (never a real job, customer or
 * company): "Sample Customer Ltd", "J-0000". Pure.
 */
import { emptyWorksheet, type JobWorksheet } from "@/lib/job-worksheet";
import { EMPTY_CUSTOM_VALUES, type CustomValues } from "@/lib/worksheet-builder/custom-values";

export const SAMPLE_WORKSHEET: JobWorksheet = {
  ...emptyWorksheet({ job_no: "J-0000", customer: "Sample Customer Ltd", description: "Sample description: 20 brackets, machine from bar, deburr and bag.", quantity_required: 20 }),
  customer_po: "PO-0000", date_received: "2026-01-05T12:00:00Z", date_required: "2026-01-19T12:00:00Z", quote_ref: "QUO-0000", dimension_report_no: "DR-1",
  material_cert_no: "CERT-0000", heat_cast_no: "HEAT-0000", drawing_no: "DWG-0000", machine_1: "Machine 1", program_1: "O1001", machine_2: "Machine 2",
  job_time_quoted_hr: "4", job_time_taken_hr: "", setup_time_hr: "1", run_time_hr: "3", checklist: { sizes_checked: true }, checked_by: "A. Sample",
};

export const SAMPLE_DRAWINGS = ["DWG-0000.pdf (Rev A)"];

export const SAMPLE_CUSTOM_VALUES: CustomValues = EMPTY_CUSTOM_VALUES;
