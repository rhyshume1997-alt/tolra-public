// Builds a minimal .xlsx (several worksheets) for the SliQ importer tests, with no spreadsheet library: an .xlsx is a zip of
// XML parts. Cells: a string (stored as text, so leading zeros survive), a number, a { date: "YYYY-MM-DD" } (a real date cell)
// or null (empty).
//
//   node tests/support/make-xlsx.mjs <out.xlsx>   writes the committed fixture tests/fixtures/sliq/xlsx/reports.xlsx
import { writeFileSync } from "node:fs";

import { strToU8, zipSync } from "fflate";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i) => String.fromCharCode(65 + i);
const serial = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000) + 25569;

function sheetXml(rows) {
  const body = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${col(ci)}${ri + 1}`;
          if (v === null || v === undefined) return "";
          if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
          if (typeof v === "object" && v.date) return `<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** @param {{name: string, rows: unknown[][]}[]} sheets */
export function buildXlsx(sheets) {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows);
  });
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
}

/** The committed fixture: a reports workbook with several worksheets, one of which matches nothing. */
export function reportsWorkbook() {
  return buildXlsx([
    { name: "Summary", rows: [["Report", "Run date"], ["Sales listing", "ignore me"]] },
    {
      name: "Sales Invoices",
      rows: [
        ["Number", "Customer", "Invoice Date", "Due Date", "Net", "VAT", "Gross", "Status"],
        ["INV-00123", "Xlsx Customer Ltd", { date: "2026-03-05" }, { date: "2026-04-04" }, 100, 20, 120, "Unpaid"],
        ["00045", "Xlsx Customer Ltd", { date: "2026-03-20" }, null, 50, 10, 60, "Paid"],
      ],
    },
    {
      name: "Customer List",
      rows: [
        ["Company Name", "Contact Name", "Email Address", "Phone Number", "Address", "Notes"],
        ["Xlsx Customer Ltd", "Xena X", "x@example.test", null, "1 Sheet Street", null],
      ],
    },
    {
      name: "Receipts",
      rows: [
        ["Invoice Number", "Date", "Amount", "Method", "Reference"],
        ["INV-00123", { date: "2026-03-10" }, 40, "BACS", "XLS1"],
      ],
    },
  ]);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  writeFileSync(process.argv[2], reportsWorkbook());
}
