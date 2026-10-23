import { strFromU8, unzipSync } from "fflate";
import readExcelFile from "read-excel-file/node";
import { describe, expect, it } from "vitest";

import { exportScopeTitle, toCsv, toXlsx, type SheetColumn } from "@/lib/spreadsheet";

type Row = { name: string; qty?: number; price?: number | string | null; day?: string };
const columns: SheetColumn<Row>[] = [
  { header: "Name", type: "text", value: (r) => r.name },
  { header: "Qty", type: "number", value: (r) => r.qty },
  { header: "Price", type: "money", value: (r) => r.price },
  { header: "Day", type: "date", value: (r) => r.day },
];

describe("toCsv", () => {
  it("is UTF-8 with a BOM, CRLF line ends and a final CRLF", () => {
    const csv = toCsv(columns, [{ name: "Bracket", qty: 2, price: 12.5, day: "2026-10-19" }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe("Name,Qty,Price,Day\r\nBracket,2,12.50,2026-10-19\r\n");
  });

  it("quotes fields with a comma, quote or line break and doubles quotes (RFC 4180)", () => {
    const csv = toCsv(columns, [{ name: 'Plate, 6" "A"' }, { name: "line1\nline2" }, { name: "a\r\nb" }]);
    expect(csv).toContain('"Plate, 6"" ""A"""');
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain('"a\r\nb"');
  });

  it("writes money to 2 dp, keeps non-ASCII, and leaves empty cells empty", () => {
    const csv = toCsv(columns, [{ name: "Café £5", price: 3 }, { name: "y", price: null }, { name: "z", price: "abc" }]);
    expect(csv).toContain("Café £5,,3.00,");
    expect(csv).toContain("\r\ny,,,\r\n");
    expect(csv).toContain("z,,abc,");
  });

  it("neutralises formulas in text with a leading apostrophe, but not plain numbers or negative amounts", () => {
    for (const name of ["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\tx", "\rx"]) {
      const body = toCsv(columns, [{ name }]).slice(1).split("\r\n").slice(1).join("\r\n");
      expect(body.startsWith(`'${name}`) || body.startsWith(`"'${name}`)).toBe(true);
    }
    expect(toCsv(columns, [{ name: "-12.50", price: -12.5, qty: -3 }])).toContain("\r\n-12.50,-3,-12.50,\r\n");
  });
});

describe("toXlsx", () => {
  const rows: Row[] = [
    { name: "Bracket & <plate>", qty: 2, price: 12.5, day: "2026-10-19" },
    { name: "=1+1", qty: 5, price: 0.1 + 0.2, day: "" },
    { name: "  padded  " },
  ];

  it("is a zip with the parts Excel and LibreOffice require", async () => {
    const files = unzipSync(await toXlsx("Invoices", columns, rows));
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(strFromU8(files["xl/worksheets/sheet1.xml"])).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(strFromU8(files["xl/workbook.xml"])).toContain('<sheet name="Invoices" sheetId="1" r:id="rId1"/>');
  });

  it("round-trips through read-excel-file: header, strings, numbers as numbers, dates as ISO text", async () => {
    const parsed = await readExcelFile(Buffer.from(await toXlsx("Invoices", columns, rows)));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sheet).toBe("Invoices");
    expect(parsed[0].data[0]).toEqual(["Name", "Qty", "Price", "Day"]);
    expect(parsed[0].data[1]).toEqual(["Bracket & <plate>", 2, 12.5, "2026-10-19"]);
    // Text that looks like a formula stays text; money is rounded to pence (0.1 + 0.2 -> 0.3); an empty cell is null.
    expect(parsed[0].data[2]).toEqual(["=1+1", 5, 0.3, null]);
    // Leading / trailing spaces are kept in the file (the reader trims them on the way out).
    expect(strFromU8(unzipSync(await toXlsx("Invoices", columns, rows))["xl/worksheets/sheet1.xml"])).toContain('<t xml:space="preserve">  padded  </t>');
  });

  it("copes with no rows, a bad sheet name and characters XML can't hold", async () => {
    const empty = await readExcelFile(Buffer.from(await toXlsx("a/b:c*?[x]", columns, [])));
    expect(empty[0].sheet).toBe("a b c   x");
    expect(empty[0].data).toEqual([["Name", "Qty", "Price", "Day"]]);
    const odd = await readExcelFile(Buffer.from(await toXlsx("S", columns, [{ name: "a\u0000b\u0008c" }])));
    expect(odd[0].data[1][0]).toBe("abc");
  });
});

describe("exportScopeTitle", () => {
  it("says whether the selection or the whole filter is exported", () => {
    expect(exportScopeTitle("invoice", 3, 40)).toBe("Exports the 3 invoices selected");
    expect(exportScopeTitle("invoice", 1, 40)).toBe("Exports the 1 invoice selected");
    expect(exportScopeTitle("job", 0, 12)).toBe("Exports all 12 jobs in the current filter (nothing is selected)");
  });
});
