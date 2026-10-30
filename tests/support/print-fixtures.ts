/**
 * Fixture jobs for the print-pack render tests (tests/unit/print-layout*.test.ts): one fully filled worksheet signed with a
 * co-signature and a customer sign-off, one signed on an earlier revision (stale), and one with only the old typed sign-off box.
 * Dates are noon UTC so the printed day is the same in any time zone.
 */
import { EMPTY_BANK_DETAILS } from "@/lib/bank-details";
import type { CompanyProfile } from "@/lib/company";
import type { JobSignOff, PrintedSignOff } from "@/lib/job-signoff";
import { emptyWorksheet, type JobWorksheet } from "@/lib/job-worksheet";

export const PRINT_COMPANY: CompanyProfile = {
  key: "org", name: "Acme Fabrication", documentName: "Acme Fabrication Ltd", addressLines: ["1 High St", "Town", "AB1 2CD"], phone: "0100 000", fax: "",
  email: "office@acme.test", website: "", vatNumber: "GB123", vatRegistered: true, defaultVatRate: 20, brandPrimary: "", brandAccent: "", loginTagline: "",
  brandedLogin: false, loginStyle: "light", loginEyebrow: "", appIconPath: "", logoPath: "org/logo.png", logoSrc: "data:image/png;base64,AAAA",
  defaultQuoteTerms: "", defaultInvoiceTerms: "30 days", defaultCustomerMessage: [], defaultInvoiceMessage: [],
  bankDetails: { ...EMPTY_BANK_DETAILS },
  showCreditsInBalance: false, workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5],
};

export const FULL_SHEET: JobWorksheet = {
  ...emptyWorksheet({ job_no: "J-0101", customer: "Bracket Co", description: "Machine 20 brackets\nDeburr and bag" }),
  customer_po: "PO-77", date_received: "2026-10-01T12:00:00Z", date_required: "2026-10-15T12:00:00Z", quote_ref: "QUO-0101", dimension_report_no: "DR-5",
  material_cert_no: "MC-9", heat_cast_no: "H-123", job_time_quoted_hr: "4", job_time_taken_hr: "5.5", drawing_no: "DWG-42", quantity_required: "20",
  material_required: "6082-T6 bar", material_ordered: true, material_ordered_at: "2026-10-02T12:00:00Z", material_ordered_notes: "next day", material_supplier: "MetalCo",
  machine_1: "Haas VF-2", program_1: "O1001", machine_2: "Mazak", program_2: "", machine_3: "", program_3: "", setup_time_hr: "1", run_time_hr: "3",
  improvement_comments: "Use a softer jaw", overrun_reasons: "Tool broke", checklist: { sizes_checked: true, parts_counted: true }, checked_by: "Rita Hale",
};
export const STALE_SHEET: JobWorksheet = { ...emptyWorksheet({ job_no: "J-0102", customer: "Plate Ltd", description: "Plates", quantity_required: 4 }), date_required: "2026-11-01T12:00:00Z" };
export const LEGACY_SHEET: JobWorksheet = { ...emptyWorksheet({ job_no: "J-0103", customer: "Shaft plc", description: "Shafts" }), signed_off_by: "Old Name", signed_off_at: "2026-09-01T12:00:00Z" };

const row = (over: Partial<JobSignOff>): JobSignOff => ({
  id: "s1", job_id: "job-1", worksheet_version: 3, snapshot: {}, snapshot_sha256: "a".repeat(64), record_sha256: "b".repeat(64), initials: "RH", signer_name: "Rita Hale",
  signed_on: "2026-10-16T12:00:00Z", signature_kind: "typed", signature_data: "Rita Hale", signed_by: "u1", kind: "primary", created_at: "2026-10-16T12:00:00Z", ...over,
});

export const SIGN_OFFS = new Map<string, PrintedSignOff>([
  ["J-0101", {
    status: "signed", latest: row({}), cosigns: [row({ id: "s2", kind: "inspector", initials: "IK", signer_name: "Ian King", signature_kind: "drawn", signature_data: "org/sig.png" })],
    customer: [row({ id: "c1", kind: "customer", signer_name: "Jane Smith", signer_position: "Site Manager", signer_company: "Bracket Co", statement: "I confirm the work.", customer_comment: "Good job", device_signed_at: "2026-10-16T13:00:00Z", created_at: "2026-10-16T13:05:00Z" })],
  }],
  ["J-0102", { status: "stale", latest: row({ id: "s3", worksheet_version: 1 }), currentVersion: 2 }],
]);

export const PACK = [
  { id: "job-1", worksheet: FULL_SHEET, drawings: ["DWG-42.pdf (Rev B)"] },
  { id: "job-2", worksheet: STALE_SHEET, drawings: [] },
  { id: "job-3", worksheet: LEGACY_SHEET, drawings: [] },
];
