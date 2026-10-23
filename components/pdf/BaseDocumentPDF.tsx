import { type StoredTotals, totalsMismatch } from "@/lib/document-integrity";
import { Document, Image, Page, Path, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";

import { type CompanyProfile, footerContactRows, getCompanyProfile } from "@/lib/company";
import type { PdfCustomerSignOff } from "@/lib/customer-signoff-print";
import { parseSignaturePath, PAD_HEIGHT, PAD_WIDTH } from "@/components/signature-pad";
import { documentTotals, fromPence, isTextLine, linePence, toPence, type VatBreakdownRow, vatRowLabel } from "@/lib/money";
import { vatColumnText } from "@/lib/vat";

/**
 * One layout for every printed document (quote, invoice, delivery note, purchase order, sales order),
 * reproducing JNR's existing paperwork: company name and key/value box top left, big title and logo top
 * right, address blocks, a ruled line-item table filling down to a fixed height, customer message and
 * totals along the bottom, company footer. A4, Helvetica, thin black rules.
 */

export type PdfLineItem = {
  description: string;
  quantity: number;
  /** Ex-VAT price of one. Ignored in `qtyOnly` and `descriptionOnly` documents. */
  unitPrice?: number;
  /** VAT percentage for this line. Defaults to the document's standard rate when VAT is shown. */
  vatPct?: number;
  /** Outside the scope of VAT: no VAT, and the VAT% column prints "Exempt". */
  vatExempt?: boolean;
  /** The VAT of this line where it was fixed when the document was made (a credit note's share of the invoice line's VAT): printed totals use it instead of working it out. */
  vatAmount?: number;
};

export type PdfKeyValue = { label: string; value: string };

export type PdfColumns = "priced" | "qtyOnly" | "descriptionOnly";

export type PdfDocumentData = {
  /** Big title top right, for example "QUOTE" or "DELIVERY NOTE". Printed upper-case. */
  title: string;
  /** Document number, used for the PDF's metadata. The printed copy comes from `keyValues`. */
  documentNumber: string;
  /** Rows of the bordered box under the company name. */
  keyValues: PdfKeyValue[];
  /** Heading of the left address block, for example "Quote To:", "Invoice To:" or "Supplier:". */
  billToLabel: string;
  billTo: string[];
  /** Heading of the right address block. Defaults to "Deliver To:". */
  deliverToLabel?: string;
  deliverTo: string[];
  /** `priced` = Description, Qty, Each, VAT%, Total. `qtyOnly` = Description, Qty (delivery notes). */
  columns?: PdfColumns;
  lineItems: PdfLineItem[];
  /** The document's "Add VAT" switch. Off hides the VAT% column and every VAT line. Default true.
   *  Always off when the company is not VAT registered. */
  showVat?: boolean;
  /** Carriage carries VAT at the standard rate (documents created with the VAT options). Default false, so older
   *  documents keep the totals they were issued with. */
  carriageVat?: boolean;
  /** Standard rate (lines without their own rate, and carriage). Defaults to the company's default VAT rate. */
  standardVatRate?: number;
  /** Ex-VAT carriage. */
  carriage?: number;
  /** When set (invoices) the totals end with Invoice total, Paid and Balance due. */
  payments?: number;
  /** Credit notes applied to the invoice: taken off the Balance due only (Paid still shows the payments). Omit for none. */
  credits?: number;
  /** Lines of the bottom-left box. Defaults to the company's standard customer message. */
  customerMessage?: string[];
  /** Heading of that box. Defaults to "Customer Message". */
  customerMessageTitle?: string;
  /** Rows of a "Payment details" block under the message box (invoices only). Omit or empty: nothing is printed. */
  paymentDetails?: Array<{ label: string; value: string }>;
  /** The job's customer sign-off (migration 072), as a small block under the message box. Omit and nothing is printed or moved. */
  customerSignOff?: PdfCustomerSignOff;
  /** Prints the big diagonal green PAID watermark. */
  paid?: boolean;
  /** Which company prints the document. Pass the profile from requireCompanyProfile(); the fallback throws when the organisation has no profile. */
  company?: CompanyProfile;
  /** Override for the logo image (e.g. a file path when rendering outside the browser). Defaults to company.logoSrc. */
  logoSrc?: string;
  /** The totals stored on the record (quotes and invoices). When set, the document refuses to render if its lines
   *  add up to anything else, so a reprint can never show amounts that weren't issued. */
  storedTotals?: StoredTotals & { reference: string; issued: boolean };
};

export type PdfTotals = { subtotal: number; carriage: number; vat: number; total: number; payments: number | null; balance: number; vatBreakdown: VatBreakdownRow[] };

/**
 * The closing rows of the totals block. Without payments (quotes, POs): Total. With payments (invoices): the
 * invoice's own gross total, what has been paid and the balance due, so a paid invoice never reads "Total £0.00"
 * (audit A13).
 */
export function finalTotalRows(totals: Pick<PdfTotals, "total" | "payments" | "balance">): { label: string; value: number; bold: boolean }[] {
  if (totals.payments === null) return [{ label: "Total", value: totals.total, bold: true }];
  return [
    { label: "Invoice total", value: totals.total, bold: false },
    { label: "Paid", value: totals.payments, bold: false },
    { label: "Balance due", value: totals.balance, bold: true },
  ];
}

export function lineTotal(item: PdfLineItem) {
  return fromPence(linePence(item.quantity, item.unitPrice ?? 0));
}

/**
 * Subtotal, VAT (rounded per line), carriage, total and balance due. Delegates to documentTotals in lib/money.ts
 * so the quote builder preview, the saved totals and the PDF can never drift apart.
 */
export function computePdfTotals(data: Pick<PdfDocumentData, "lineItems" | "showVat" | "carriage" | "payments" | "credits" | "carriageVat" | "standardVatRate">): PdfTotals {
  const totals = documentTotals(
    data.lineItems.map((item) => ({ quantity: item.quantity, unitPrice: item.unitPrice ?? 0, vatPct: item.vatPct, vatExempt: item.vatExempt, vatAmount: item.vatAmount })),
    data.carriage ?? 0,
    { vatEnabled: data.showVat !== false, carriageVat: data.carriageVat, standardRate: data.standardVatRate ?? 20 },
  );
  const payments = data.payments === undefined ? null : fromPence(toPence(data.payments));
  const balance = fromPence(toPence(totals.total) - toPence(payments ?? 0) - toPence(payments === null ? 0 : data.credits ?? 0));
  return { subtotal: totals.subtotal, carriage: totals.carriage, vat: totals.vat, total: totals.total, payments, balance, vatBreakdown: totals.vatBreakdown };
}

const INK = "#000000";
const RULE = "#000000";
const SOFT_RULE = "#8c8c8c";

/** Width of the big title's column (top right), and of the company name's column (top left) beside it. A4 content is 547pt wide. */
export const TITLE_WIDTH = 240;
export const COMPANY_NAME_WIDTH = 290;
export const TITLE_MAX_FONT_SIZE = 21;
const TITLE_MIN_FONT_SIZE = 9;
/** Helvetica-Bold upper-case averages under 0.72em a letter; used to shrink a long title until it fits TITLE_WIDTH on one line. */
const TITLE_EM_PER_CHAR = 0.72;

/** Font size of the printed title: 21pt, smaller for a long title so it fits its column (never below 9pt, where it is clipped with "..." instead). */
export function titleFontSize(title: string) {
  const chars = Math.max(1, title.length);
  return Math.min(TITLE_MAX_FONT_SIZE, Math.max(TITLE_MIN_FONT_SIZE, Math.floor((TITLE_WIDTH / (chars * TITLE_EM_PER_CHAR)) * 10) / 10));
}

// Helvetica-Bold advance widths (1/1000 em) of the characters company names use; anything else counts as 600.
const BOLD_WIDTHS: Record<string, number> = {
  " ": 278, ".": 278, ",": 278, "&": 722, "-": 333, "'": 238, "(": 333, ")": 333, "/": 278,
  ...Object.fromEntries([..."0123456789"].map((c) => [c, 556])),
  ...Object.fromEntries(Object.entries({ A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500 })),
};
const boldWidth = (text: string, size: number) => ([...text].reduce((sum, c) => sum + (BOLD_WIDTHS[c] ?? 600), 0) * size) / 1000;

/** Lines `name` takes in a column `width` wide at `size` (greedy word wrap, like the renderer's). */
function wrappedLines(name: string, size: number, width: number) {
  let lines = 1;
  let used = 0;
  for (const word of name.split(/\s+/).filter(Boolean)) {
    const w = boldWidth(word, size);
    const sep = used ? boldWidth(" ", size) : 0;
    if (used && used + sep + w > width) { lines += 1; used = w; } else used += sep + w;
    if (w > width) lines += Math.ceil(w / width) - 1; // one word wider than the column breaks across lines
  }
  return lines;
}

const COMPANY_NAME_TOP = 46;
/** Bottom of the company name's area: the key/value box starts at 71. */
const COMPANY_NAME_BOTTOM = 69;

/**
 * Size and position of the company name, which is never truncated: 16pt on one line as always when it fits (every name today),
 * else one line down to 13pt, else two lines (the largest size that fits, 12pt down to 6pt) moved up so the second line still
 * ends above the key/value box. Always inside COMPANY_NAME_WIDTH, clear of the title's column.
 */
export function companyNameLayout(name: string) {
  for (let size = 16; size >= 13; size -= 0.5) if (wrappedLines(name, size, COMPANY_NAME_WIDTH) === 1) return { fontSize: size, top: COMPANY_NAME_TOP };
  let size = 12;
  while (size > 6 && wrappedLines(name, size, COMPANY_NAME_WIDTH) > 2) size -= 0.5;
  return { fontSize: size, top: COMPANY_NAME_BOTTOM - 2 * size * 1.2, lineHeight: 1.2 };
}

/** Lines the company name prints on (for tests): 1 at 13pt or more, else up to 2. */
export const companyNameLines = (name: string) => wrappedLines(name, companyNameLayout(name).fontSize, COMPANY_NAME_WIDTH);

/** The printed title: upper-case, cut with "..." only when even the smallest size would not fit its column. */
export function printedTitle(title: string) {
  const text = title.toUpperCase();
  const max = Math.floor(TITLE_WIDTH / (TITLE_MIN_FONT_SIZE * TITLE_EM_PER_CHAR));
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

export const styles = StyleSheet.create({
  page: { paddingTop: 30, paddingBottom: 158, paddingHorizontal: 24, fontFamily: "Helvetica", fontSize: 8.8, color: INK },

  // Company name (left) and title (right) each get their own column, so neither can run under the other: the name's column ends
  // at COMPANY_NAME_WIDTH, the title's starts at 571 - TITLE_WIDTH. The title stays on one line (the key/value box and logo sit
  // just below); the company name is never cut: see companyNameLayout.
  companyName: { position: "absolute", top: 46, left: 24, width: COMPANY_NAME_WIDTH, fontFamily: "Helvetica-Bold", fontSize: 16 },
  title: { position: "absolute", top: 36.5, right: 24, width: TITLE_WIDTH, fontFamily: "Helvetica-Bold", fontSize: TITLE_MAX_FONT_SIZE, textAlign: "right", maxLines: 1, textOverflow: "ellipsis" },
  keyValueBox: { position: "absolute", top: 71, left: 24, width: 236, borderWidth: 0.6, borderColor: SOFT_RULE },
  kvRow: { flexDirection: "row", height: 17.3 },
  kvRowBorder: { borderTopWidth: 0.6, borderTopColor: SOFT_RULE },
  kvLabel: { width: 73, paddingLeft: 2, paddingTop: 1.3, fontSize: 9.5, borderRightWidth: 0.6, borderRightColor: SOFT_RULE },
  kvValue: { flex: 1, paddingLeft: 3, paddingTop: 1.3, fontSize: 9.5, maxLines: 1, textOverflow: "ellipsis" },
  logo: { position: "absolute", top: 68, right: 24, width: 134, height: 97, objectFit: "contain" },
  logoFallback: { position: "absolute", top: 68, right: 24, width: 134, height: 97, justifyContent: "center" },
  logoFallbackText: { fontFamily: "Helvetica-Bold", fontSize: 14, color: "#1E3472", textAlign: "right" },

  addressBlock: { position: "absolute", top: 174, width: 201 },
  addressHeading: { fontFamily: "Helvetica-Bold", fontSize: 9, paddingBottom: 3, borderBottomWidth: 0.8, borderBottomColor: INK, marginBottom: 6 },
  addressLine: { fontSize: 8.8, lineHeight: 1.24 },

  tableSpacer: { height: 250 },
  table: { borderWidth: 1, borderColor: RULE, minHeight: 292, flexDirection: "column" },
  headRow: { flexDirection: "row", height: 20, borderBottomWidth: 1, borderBottomColor: RULE },
  row: { flexDirection: "row", minHeight: 22.4 },
  fillRow: { flexDirection: "row", flexGrow: 1 },
  cellLeft: { borderLeftWidth: 1, borderLeftColor: RULE },
  headText: { fontFamily: "Helvetica-Bold", fontSize: 9, textAlign: "center", paddingTop: 5.4 },
  descText: { fontSize: 8.8, paddingLeft: 5, paddingRight: 5, paddingTop: 5.6, paddingBottom: 5.5, lineHeight: 1.3 },
  numText: { fontSize: 8.8, paddingTop: 5.6, textAlign: "right" },

  bottomRow: { flexDirection: "row", marginTop: 19.9, justifyContent: "space-between", alignItems: "flex-start" },
  messageBlock: { width: 324 },
  messageHeading: { fontFamily: "Helvetica-Bold", fontSize: 9, height: 11 },
  messageBox: { borderWidth: 0.6, borderColor: SOFT_RULE, minHeight: 77, paddingLeft: 1, paddingTop: 3 },
  messageLine: { fontSize: 8.8, marginBottom: 12, lineHeight: 1.1 },
  paymentHeading: { fontFamily: "Helvetica-Bold", fontSize: 9, height: 11, marginTop: 8 },
  paymentRow: { flexDirection: "row", marginBottom: 2.5 },
  paymentLabel: { width: 82, fontFamily: "Helvetica-Bold", fontSize: 8.8 },
  paymentValue: { fontSize: 8.8 },
  signOffHeading: { fontFamily: "Helvetica-Bold", fontSize: 9, height: 11, marginTop: 8 },
  signOffBox: { borderWidth: 0.6, borderColor: SOFT_RULE, paddingHorizontal: 4, paddingVertical: 3 },
  signOffName: { fontFamily: "Helvetica-Bold", fontSize: 8.8 },
  signOffStatement: { fontFamily: "Helvetica-Oblique", fontSize: 8, marginTop: 1 },
  signOffSignature: { height: 30, marginTop: 2, justifyContent: "center" },
  signOffTyped: { fontFamily: "Helvetica-Oblique", fontSize: 14 },
  signOffWhen: { fontSize: 8, marginTop: 1 },
  totalsBlock: { width: 167, marginRight: 5, marginTop: 2.5 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", height: 17.3 },
  totalLabel: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  totalValue: { fontSize: 9.5 },
  totalValueBold: { fontFamily: "Helvetica-Bold", fontSize: 9.5 },

  footer: { position: "absolute", top: 686.1, left: 24, right: 24 },
  footerName: { fontFamily: "Helvetica-Bold", fontSize: 8, paddingBottom: 3, borderBottomWidth: 0.8, borderBottomColor: INK, marginBottom: 5 },
  footerCols: { flexDirection: "row", justifyContent: "space-between" },
  footerAddress: { fontSize: 8.2, lineHeight: 1.18 },
  footerContact: { width: 212 },
  footerContactRow: { flexDirection: "row", marginBottom: 3 },
  footerContactLabel: { width: 46, fontFamily: "Helvetica-Bold", fontSize: 8.2 },
  footerContactValue: { fontSize: 8.2 },
  footerRule: { position: "absolute", top: 782, left: 24, right: 24, borderTopWidth: 0.6, borderTopColor: SOFT_RULE },

  watermark: { position: "absolute", top: 38, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  watermarkText: { fontFamily: "Helvetica-Bold", fontSize: 180, color: "#00ff00", opacity: 0.55, transform: "rotate(45deg)" },
});

const number = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const amount = (value: number) => number.format(value);
const money = (value: number) => gbp.format(value);

function columnWidths(columns: PdfColumns, showVat: boolean) {
  if (columns === "qtyOnly") return [385, 161];
  if (columns === "descriptionOnly") return [546];
  return showVat ? [285.5, 65.5, 66.5, 62.5, 66] : [351, 65.5, 66.5, 63];
}

/**
 * Style of a table column. The first (Description) column takes whatever width the fixed columns leave, so the table's own
 * border can never push its right edge past the box (a fixed 546pt column overran the 545pt inside the border and clipped the
 * last characters of each line); its text wraps inside it. The others keep their fixed widths.
 */
export function columnStyle(widths: number[], index: number) {
  return index === 0 ? { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 } : { width: widths[index] };
}

function headings(columns: PdfColumns, showVat: boolean) {
  if (columns === "qtyOnly") return ["Description", "Qty"];
  if (columns === "descriptionOnly") return ["Description"];
  return showVat ? ["Description", "Qty", "Each", "VAT%", "Total"] : ["Description", "Qty", "Each", "Total"];
}

function cells(item: PdfLineItem, columns: PdfColumns, showVat: boolean, standardRate: number) {
  if (columns === "descriptionOnly") return [item.description];
  if (columns === "qtyOnly") return [item.description, amount(item.quantity)];
  // A £0 text-only invoice line (migration 073): its words only, nothing in the money columns.
  if (isTextLine(item)) return showVat ? [item.description, "", "", "", ""] : [item.description, "", "", ""];
  const base = [item.description, amount(item.quantity), amount(item.unitPrice ?? 0)];
  return showVat ? [...base, vatColumnText(item.vatPct, item.vatExempt, standardRate), amount(lineTotal(item))] : [...base, amount(lineTotal(item))];
}

// Right padding of the numeric columns, matching the original paperwork.
const NUMERIC_PADDING: Record<string, number> = { Qty: 7, Each: 5, "VAT%": 8, Total: 5 };

type TotalsInput = Pick<PdfDocumentData, "lineItems" | "showVat" | "carriage" | "carriageVat" | "standardVatRate" | "company" | "columns" | "storedTotals">;

/**
 * The VAT switch, standard rate and totals a document prints with, from the document's own settings and the printing
 * company (for an issued document, its issue-time snapshot). One place, so the printed totals, the stored-totals check
 * and on-screen copies of them (the invoice details panel) can never disagree.
 */
export function resolvePdfTotals(
  data: Pick<PdfDocumentData, "lineItems" | "showVat" | "carriage" | "carriageVat" | "standardVatRate" | "columns" | "payments" | "credits">,
  company: Pick<CompanyProfile, "vatRegistered" | "defaultVatRate">,
) {
  // A company that isn't VAT registered never prints VAT, whatever the document says.
  const showVat = (data.columns ?? "priced") === "priced" && data.showVat !== false && company.vatRegistered !== false;
  const standardVatRate = data.standardVatRate ?? company.defaultVatRate ?? 20;
  return { showVat, standardVatRate, totals: computePdfTotals({ ...data, showVat, standardVatRate }) };
}

/**
 * The reason a document can't be rendered from its lines (they don't add up to the totals stored on the record), or
 * null. Same VAT and rounding rules as the printed totals. Callers check it first to explain; rendering enforces it.
 */
export function storedTotalsProblem(data: TotalsInput) {
  if (!data.storedTotals) return null;
  const { totals } = resolvePdfTotals(data, data.company ?? getCompanyProfile());
  const { reference, issued, ...stored } = data.storedTotals;
  return totalsMismatch(reference, stored, totals, issued);
}

/** Height the customer sign-off block takes under the message box (heading, name, a two-line statement, signature, time), taken from the table. */
const CUSTOMER_SIGNOFF_HEIGHT = 104;

function CustomerSignOffBlock({ signOff }: { signOff: PdfCustomerSignOff }) {
  const path = signOff.signature.kind === "drawn" ? parseSignaturePath(signOff.signature.data) : null;
  return (
    <View wrap={false}>
      <Text style={styles.signOffHeading}>Customer sign-off</Text>
      <View style={styles.signOffBox}>
        <Text style={styles.signOffName}>{signOff.name}</Text>
        {signOff.statement ? <Text style={styles.signOffStatement}>{`\u201C${signOff.statement}\u201D`}</Text> : null}
        <View style={styles.signOffSignature}>
          {signOff.signature.kind === "typed"
            ? <Text style={styles.signOffTyped}>{signOff.signature.data}</Text>
            : path
              ? <Svg viewBox={`0 0 ${PAD_WIDTH} ${PAD_HEIGHT}`} style={{ width: 90, height: 30 }}><Path d={path} stroke="#000000" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
              : null}
        </View>
        <Text style={styles.signOffWhen}>Signed {signOff.signedAt}</Text>
      </View>
    </View>
  );
}

export function BaseDocumentPDF({ data }: { data: PdfDocumentData }) {
  const company = data.company ?? getCompanyProfile();
  const columns = data.columns ?? "priced";
  const priced = columns === "priced";
  const { showVat, standardVatRate, totals } = resolvePdfTotals(data, company);
  const widths = columnWidths(columns, showVat);
  const heads = headings(columns, showVat);
  const mismatch = storedTotalsProblem(data);
  if (mismatch) throw mismatch;
  // One VAT row per rate charged; a single "VAT:" row when there is only one (or none) to show.
  const vatRows = totals.vatBreakdown.filter((row) => !row.exempt);
  // The totals block was laid out for at most 5 rows (Subtotal, Carriage, VAT, Payments, Total). Each extra VAT-rate
  // row takes its height from the line-item table, so the bottom block still fits on page one.
  const totalsRows = 2 + (showVat ? Math.max(1, vatRows.length) : 0) + (totals.payments === null ? 1 : 3);
  // The "Payment details" block (invoices with bank details) sits under the message box and is taken from the table the same way;
  // a document without one is laid out exactly as before.
  const paymentRows = data.paymentDetails?.length ?? 0;
  const paymentExtra = paymentRows ? 19 + paymentRows * 13 : 0;
  // The customer sign-off block (072) is taken from the table the same way, so a document with one still fits page one.
  const signOffExtra = data.customerSignOff ? CUSTOMER_SIGNOFF_HEIGHT : 0;
  const tableMinHeight = Math.max(110, 292 - Math.max(0, totalsRows - 5) * 17.3 - paymentExtra - signOffExtra);
  const message = data.customerMessage ?? company.defaultCustomerMessage;
  const kv = data.keyValues;
  // Only the organisation's own uploaded logo (resolved in lib/company); otherwise its name is printed instead.
  const logo = data.logoSrc ?? company.logoSrc;

  return (
    <Document title={`${data.title} ${data.documentNumber}`} author={company.name} creator={company.name}>
      <Page size="A4" style={styles.page}>
        <Text style={[styles.companyName, companyNameLayout(company.documentName)]}>{company.documentName}</Text>
        <Text style={[styles.title, { fontSize: titleFontSize(data.title) }]}>{printedTitle(data.title)}</Text>
        <View style={styles.keyValueBox}>
          {kv.map((row, index) => (
            <View key={`${row.label}-${index}`} style={[styles.kvRow, index > 0 ? styles.kvRowBorder : {}]}>
              <Text style={styles.kvLabel}>{row.label}</Text>
              <Text style={styles.kvValue}>{row.value}</Text>
            </View>
          ))}
        </View>
        {/* react-pdf Image: a PDF primitive, not an HTML img, so it has no alt attribute. */}
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        {logo ? <Image src={logo} style={styles.logo} /> : (
          <View style={styles.logoFallback}><Text style={styles.logoFallbackText}>{company.name}</Text></View>
        )}

        <View style={[styles.addressBlock, { left: 58.5 }]}>
          <Text style={styles.addressHeading}>{data.billToLabel}</Text>
          {data.billTo.map((line, index) => <Text key={`${line}-${index}`} style={styles.addressLine}>{line}</Text>)}
        </View>
        <View style={[styles.addressBlock, { left: 323.5 }]}>
          <Text style={styles.addressHeading}>{data.deliverToLabel ?? "Deliver To:"}</Text>
          {data.deliverTo.map((line, index) => <Text key={`${line}-${index}`} style={styles.addressLine}>{line}</Text>)}
        </View>

        <View style={styles.tableSpacer} />
        <View style={[styles.table, { minHeight: tableMinHeight }]}>
          <View style={styles.headRow} fixed>
            {heads.map((heading, index) => (
              <View key={heading} style={[columnStyle(widths, index), index > 0 ? styles.cellLeft : {}]}>
                <Text style={styles.headText}>{heading}</Text>
              </View>
            ))}
          </View>
          {data.lineItems.map((item, rowIndex) => (
            <View key={`${item.description}-${rowIndex}`} style={styles.row} wrap={false}>
              {cells(item, columns, showVat, standardVatRate).map((value, index) => (
                <View key={`${heads[index]}-${index}`} style={[columnStyle(widths, index), index > 0 ? styles.cellLeft : {}]}>
                  {index === 0
                    ? <Text style={styles.descText}>{value}</Text>
                    : <Text style={[styles.numText, heads[index] === "VAT%" ? { paddingRight: NUMERIC_PADDING["VAT%"] } : { paddingRight: NUMERIC_PADDING[heads[index]] ?? 5 }]}>{value}</Text>}
                </View>
              ))}
            </View>
          ))}
          <View style={styles.fillRow}>
            {widths.map((_, index) => <View key={index} style={[columnStyle(widths, index), index > 0 ? styles.cellLeft : {}]} />)}
          </View>
        </View>

        <View style={styles.bottomRow} wrap={false}>
          <View style={styles.messageBlock}>
            <Text style={styles.messageHeading}>{data.customerMessageTitle ?? "Customer Message"}</Text>
            <View style={styles.messageBox}>
              {message.map((line, index) => <Text key={`${line}-${index}`} style={styles.messageLine}>{line}</Text>)}
            </View>
            {data.paymentDetails?.length ? (
              <View>
                <Text style={styles.paymentHeading}>Payment details</Text>
                {data.paymentDetails.map((row) => (
                  <View key={row.label} style={styles.paymentRow}><Text style={styles.paymentLabel}>{row.label}</Text><Text style={styles.paymentValue}>{row.value}</Text></View>
                ))}
              </View>
            ) : null}
            {data.customerSignOff ? <CustomerSignOffBlock signOff={data.customerSignOff} /> : null}
          </View>
          {priced ? (
            <View style={styles.totalsBlock}>
              <View style={styles.totalRow}><Text style={styles.totalLabel}>Subtotal:</Text><Text style={styles.totalValue}>{money(totals.subtotal)}</Text></View>
              <View style={styles.totalRow}><Text style={styles.totalLabel}>Carriage:</Text><Text style={styles.totalValue}>{money(totals.carriage)}</Text></View>
              {showVat && vatRows.length > 1
                ? vatRows.map((row) => <View key={vatRowLabel(row)} style={styles.totalRow}><Text style={styles.totalLabel}>{vatRowLabel(row)}:</Text><Text style={styles.totalValue}>{money(row.vat)}</Text></View>)
                : null}
              {showVat && vatRows.length <= 1
                ? <View style={styles.totalRow}><Text style={styles.totalLabel}>{vatRows.length === 1 ? `${vatRowLabel(vatRows[0])}:` : "VAT:"}</Text><Text style={styles.totalValue}>{money(totals.vat)}</Text></View>
                : null}
              {finalTotalRows(totals).map((row) => (
                <View key={row.label} style={styles.totalRow}><Text style={styles.totalLabel}>{row.label}:</Text><Text style={row.bold ? styles.totalValueBold : styles.totalValue}>{money(row.value)}</Text></View>
              ))}
            </View>
          ) : null}
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerName}>{company.documentName}</Text>
          <View style={styles.footerCols}>
            <View>{company.addressLines.map((line, index) => <Text key={`${line}-${index}`} style={styles.footerAddress}>{line}</Text>)}</View>
            <View style={styles.footerContact}>
              {footerContactRows(company).map(([label, value]) => (
                <View key={label} style={styles.footerContactRow}><Text style={styles.footerContactLabel}>{label}</Text><Text style={styles.footerContactValue}>{value}</Text></View>
              ))}
            </View>
          </View>
        </View>
        <View style={styles.footerRule} fixed />

        {/* PAID only when this PDF's own Balance due is nil: with credit notes left off the PDF (the default), an invoice settled
            partly by a credit still shows a balance here, and must not say PAID beside it. */}
        {data.paid && totals.payments !== null && totals.balance <= 0 ? <View style={styles.watermark} fixed><Text style={styles.watermarkText}>PAID</Text></View> : null}
      </Page>
    </Document>
  );
}
