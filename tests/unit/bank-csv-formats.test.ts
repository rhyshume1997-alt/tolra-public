import { describe, expect, it } from "vitest";
import { parseStatementCsv } from "@/lib/bank/match-statement";
// Made-up transactions and representative export headings; banks can change their formats.
const layouts = [
  ["Barclays", 'Number,Date,Account,Amount,Subcategory,Memo\n1,02/11/2026,12345678,"£1,234.56",Funds Transfer,INV-123\n2,03/11/2026,12345678,-15.20,Card,TOOLS'],
  ["HSBC", 'Date,Type,Description,Paid out,Paid in,Balance\n02 Nov 2026,CR,INV-123,,"1,234.56",2000.00\n03 Nov 2026,DR,TOOLS,15.20,,1984.80'],
  ["Lloyds", 'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance\n02/11/2026,FPI,00-00-00,12345678,INV-123,,1234.56,2000.00\n03/11/2026,DEB,00-00-00,12345678,TOOLS,15.20,,1984.80'],
  ["NatWest", 'Date,Type,Description,Value,Balance,Account Name,Account Number\n02-Nov-2026,BAC,INV-123,1234.56,2000.00,Test Shop,12345678\n03-Nov-2026,POS,TOOLS,-15.20,1984.80,Test Shop,12345678'],
  ["Monzo", 'Transaction ID,Date,Time,Type,Name,Amount,Currency,Notes and #tags\ntest-1,02/11/2026,09:00:00,Faster payment,INV-123,1234.56,GBP,\ntest-2,03/11/2026,10:00:00,Card,TOOLS,-15.20,GBP,'],
  ["Starling", 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n2026-11-02,Test Customer,INV-123,FASTER PAYMENT,1234.56,2000.00\n2026-11-03,Tools Shop,TOOLS,CARD,-15.20,1984.80'],
] as const;
describe("synthetic UK bank layouts", () => {
  it.each(layouts)("reads %s credits and debits with their signs", (_, csv) => {
    const result = parseStatementCsv(`\uFEFF\r\n${csv.replaceAll("\n", "\r\n")}\r\n , , , , , , , , \r\n`);
    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((r) => r.amountPence)).toEqual([123456, -1520]);
    expect(result.lines.map((r) => r.date)).toEqual(["2026-11-02", "2026-11-03"]);
    expect(result.lines[0].description).toContain("INV-123");
  });
  it.each(['"1,23"', '"1,234,56"', '"12 34.56"', '"£1£.00"', '"1,,000.00"'])("refuses malformed money %s instead of changing its value", (amount) => {
    const result = parseStatementCsv(`Date,Details,Amount\n02/11/2026,INV-123,${amount}`);
    expect(result.lines).toEqual([]); expect(result.errors).toHaveLength(1);
  });
  it("does not net a row containing both credit and debit into a misleading receipt", () => {
    const result = parseStatementCsv("Date,Details,Debit,Credit\n02/11/2026,INV-123,20.00,100.00");
    expect(result.lines).toEqual([]); expect(result.errors).toHaveLength(1);
  });
  it("rejects an impossible text-month date", () => {
    expect(parseStatementCsv("Date,Details,Amount\n31 Nov 2026,INV-123,100.00").lines).toEqual([]);
  });
  it("keeps an invoice reference when it is separate from the counterparty", () => {
    const result = parseStatementCsv("Date,Counter Party,Reference,Amount (GBP)\n02/11/2026,Test Shop,INV-123,10.00");
    expect(result.errors).toEqual([]); expect(result.lines[0].description).toContain("Test Shop"); expect(result.lines[0].description).toContain("INV-123");
  });
  it("rejects the whole statement when the last field has an unclosed quote", () => {
    const result = parseStatementCsv('Date,Details,Amount\n02/11/2026,INV-123,10.00\n03/11/2026,INV-124,"20.00');
    expect(result.lines).toEqual([]); expect(result.errors).toHaveLength(1);
  });
  it("reports blank and fractional-penny money as invalid rather than a receipt", () => {
    const result = parseStatementCsv("Date,Details,Amount\n02/11/2026,INV-123,\n02/11/2026,INV-124,0.005");
    expect(result.lines).toEqual([]); expect(result.errors).toHaveLength(2);
  });
});
