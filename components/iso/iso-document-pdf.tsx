/**
 * One draft ISO document as a PDF (react-pdf, as components/pdf/BaseDocumentPDF.tsx does). Inputs: a FilledDocument (lib/iso/fill.ts)
 * and the company's logo (a data: URL from loadCompanyProfile, or none). Output: A4 pages with the company name and logo, the
 * "DRAFT: template for company review" header and the footer on every page.
 * Must not change: the footer and header come from lib/iso/fill.ts and print on every page; no wording is added here; it reads nothing.
 */
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import type { FilledDocument } from "@/lib/iso/fill";

const styles = StyleSheet.create({
  page: { paddingTop: 70, paddingBottom: 60, paddingHorizontal: 40, fontFamily: "Helvetica", fontSize: 10, color: "#111111" },
  draft: { position: "absolute", top: 20, left: 40, right: 40, fontSize: 9, fontFamily: "Helvetica-Bold", color: "#b45309", textAlign: "center" },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 },
  company: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  address: { fontSize: 9, color: "#444444", marginTop: 2 },
  logo: { width: 90, height: 40, objectFit: "contain" },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  clause: { fontSize: 9, color: "#555555", marginBottom: 12 },
  heading: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 4 },
  line: { marginBottom: 3, lineHeight: 1.35 },
  row: { flexDirection: "row" },
  cell: { flex: 1, borderWidth: 0.5, borderColor: "#444444", minHeight: 24, padding: 3, fontSize: 8 },
  headCell: { fontFamily: "Helvetica-Bold", backgroundColor: "#f3f4f6", minHeight: 18 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#444444", textAlign: "center" },
  pageNo: { position: "absolute", bottom: 12, left: 40, right: 40, fontSize: 8, color: "#777777", textAlign: "center" },
});

export function IsoDocumentPDF({ doc, logoSrc }: { doc: FilledDocument; logoSrc?: string }) {
  return (
    <Document title={`${doc.title} (draft)`} author={doc.companyName}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.draft} fixed>{doc.header}</Text>
        <View style={styles.top}>
          <View>
            <Text style={styles.company}>{doc.companyName}</Text>
            {doc.addressLines.map((l) => <Text key={l} style={styles.address}>{l}</Text>)}
          </View>
          {/* react-pdf Image: a PDF primitive, not an HTML img, so it has no alt attribute. */}
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          {logoSrc ? <Image src={logoSrc} style={styles.logo} /> : null}
        </View>
        <Text style={styles.title}>{doc.title}</Text>
        <Text style={styles.clause}>ISO 9001:2015 clause {doc.clause}</Text>
        {doc.sections.map((s) => (
          <View key={s.heading}>
            <Text style={styles.heading}>{s.heading}</Text>
            {s.lines.map((l, i) => <Text key={i} style={styles.line}>{l}</Text>)}
            {s.blankTable ? (
              <View>
                <View style={styles.row} wrap={false}>{s.blankTable.columns.map((c) => <Text key={c} style={[styles.cell, styles.headCell]}>{c}</Text>)}</View>
                {s.blankTable.rows.map((r, i) => <View key={i} style={styles.row} wrap={false}>{r.map((_c, j) => <Text key={j} style={styles.cell}>{" "}</Text>)}</View>)}
              </View>
            ) : null}
          </View>
        ))}
        <Text style={styles.footer} fixed>{doc.footer}</Text>
        <Text style={styles.pageNo} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </Page>
    </Document>
  );
}
