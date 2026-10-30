"use client";

import { toast } from "sonner";
import { createElement } from "react";

import { auditEvent } from "@/lib/audit";
import type { AuditTable } from "@/lib/audit-contract";
import { openPrintPack } from "@/lib/print-pack";
import { CompanyProfileMissingError, requireCompanyProfile } from "@/lib/company";
import { esc } from "@/lib/html";
import { friendlyError } from "@/lib/friendly-error";
import { toDateInput } from "@/lib/dates";
import { CSV_TYPE, XLSX_TYPE, downloadFile, toCsv, toXlsx, type SheetColumn } from "@/lib/spreadsheet";

/**
 * The title of each record export (Word heading, PDF title, download name). Short and without the company name: the PDF
 * already prints the company name top left, and a long title used to run over it.
 */
export const EXPORT_TITLES = {
  quotes: "Quotes Export",
  invoices: "Invoices Export",
  jobs: "Job Board Export",
} as const;

type ExportRow = Record<string, string | number | boolean | null | undefined>;

function rowsToTable(rows: ExportRow[]) {
  if (!rows.length) return "<p>No records to export.</p>";
  const headers = Object.keys(rows[0]);
  return `<table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${headers.map((header) => `<td>${esc(row[header])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/** `entityTable` is the record type exported (audit log); `filename` is only the download title. */
export async function exportRows(format: "word" | "pdf" | "print", filename: string, rows: ExportRow[], entityTable: AuditTable) {
  if (!rows.length) {
    toast.error("Nothing to export: no records match the current filter.");
    return;
  }

  const safeName = filename.replace(/[^\w.\- ()]/g, "_");

  void auditEvent({
    action: "EXPORT",
    entityTable,
    metadata: {
      title: filename,
      format,
      row_count: rows.length,
      columns: Object.keys(rows[0] || {}),
    },
  });

  if (format === "word") {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(filename)}</title><style>body{font-family:Arial,sans-serif}table{width:100%;border-collapse:collapse}th,td{border:1px solid #222;padding:8px;text-align:left}th{background:#f3f4f6}</style></head><body><h1>${esc(filename)}</h1>${rowsToTable(rows)}</body></html>`;
    downloadFile(`${safeName}.doc`, html, "application/msword;charset=utf-8");
    toast.success("Word export downloaded");
    return;
  }

  if (format === "pdf") {
    try {
      const company = await requireCompanyProfile();
      // The PDF renderer is loaded on the first PDF export, not with the page.
      const [{ pdf }, { BaseDocumentPDF }] = await Promise.all([import("@react-pdf/renderer"), import("@/components/pdf/BaseDocumentPDF")]);
      const pdfElement = createElement(BaseDocumentPDF, {
        data: {
          title: filename,
          documentNumber: new Date().toISOString().slice(0, 10),
          keyValues: [{ label: "Date", value: new Intl.DateTimeFormat("en-GB").format(new Date()) }, { label: "Records", value: String(rows.length) }],
          billToLabel: "Export For:",
          billTo: [company.name],
          deliverToLabel: "Prepared By:",
          deliverTo: [company.documentName, ...company.addressLines],
          columns: "descriptionOnly",
          customerMessageTitle: "Notes",
          customerMessage: ["Internal export. Not a customer document."],
          lineItems: rows.map((row) => ({
            description: Object.entries(row).map(([key, value]) => `${key}: ${String(value ?? "")}`).join(" | "),
            quantity: 1,
          })),
          company,
        },
      }) as unknown as Parameters<typeof pdf>[0];
      const blob = await pdf(pdfElement).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeName}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("PDF export downloaded");
    } catch (error) {
      toast.error(error instanceof CompanyProfileMissingError ? error.message : friendlyError(error, "Failed to export PDF. Try again."));
    }
    return;
  }

  if (!openPrintPack(filename, [`<section><h2>${esc(filename)}</h2>${rowsToTable(rows)}</section>`], entityTable)) {
    toast.error("Allow pop-ups to print");
    return;
  }
  toast.success("Printable version opened");
}

/**
 * CSV or Excel (.xlsx) export of `rows` with an import column spec (lib/import-columns.ts): every column of the spec,
 * not the columns a page displays. The caller decides which rows: the selected ones, else everything in the filter.
 */
export async function exportSpreadsheet<R>(format: "csv" | "xlsx", baseName: string, columns: SheetColumn<R>[], rows: R[], entityTable?: AuditTable) {
  if (!rows.length) {
    toast.error("There are no records to export.");
    return;
  }
  // No audit entry for a report that isn't one of the audited record types (the weekly hours).
  if (entityTable) void auditEvent({
    action: "EXPORT",
    entityTable,
    metadata: { title: baseName, format, row_count: rows.length, columns: columns.map((column) => column.header) },
  });
  const filename = `${baseName.replace(/[^\w.\- ()]/g, "_")}-${toDateInput(new Date())}.${format}`;
  try {
    if (format === "csv") downloadFile(filename, toCsv(columns, rows), CSV_TYPE);
    else downloadFile(filename, (await toXlsx(baseName, columns, rows)) as BlobPart, XLSX_TYPE);
    toast.success(`${format === "csv" ? "CSV" : "Excel"} export downloaded (${rows.length} ${rows.length === 1 ? "record" : "records"})`);
  } catch (error) {
    toast.error(friendlyError(error, "Failed to export. Try again."));
  }
}
