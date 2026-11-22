/**
 * The self-check gap list as a PDF (react-pdf). Inputs: the rows from lib/iso/gap-checklist.ts, the company name and logo. Output: A4
 * pages with the draft header and the footer on every page.
 * Must not change: it prints the rows as given (it never works out a status) and reads nothing.
 */
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import { DRAFT_HEADER, PAGE_FOOTER } from "@/lib/iso/fill";
import { gapStatusLabel, type GapRow } from "@/lib/iso/gap-checklist";

const styles = StyleSheet.create({
  page: { paddingTop: 70, paddingBottom: 60, paddingHorizontal: 40, fontFamily: "Helvetica", fontSize: 9, color: "#111111" },
  draft: { position: "absolute", top: 20, left: 40, right: 40, fontSize: 9, fontFamily: "Helvetica-Bold", color: "#b45309", textAlign: "center" },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  company: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  logo: { width: 90, height: 40, objectFit: "contain" },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  note: { fontSize: 9, color: "#444444", marginBottom: 10 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#999999" },
  head: { backgroundColor: "#f3f4f6", fontFamily: "Helvetica-Bold" },
  clause: { width: 40, padding: 3 },
  requirement: { width: 170, padding: 3 },
  status: { width: 90, padding: 3, fontFamily: "Helvetica-Bold" },
  basis: { flex: 1, padding: 3 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#444444", textAlign: "center" },
  pageNo: { position: "absolute", bottom: 12, left: 40, right: 40, fontSize: 8, color: "#777777", textAlign: "center" },
});

export function GapChecklistPDF({ rows, companyName, logoSrc }: { rows: GapRow[]; companyName: string; logoSrc?: string }) {
  return (
    <Document title="Gap checklist (draft)" author={companyName}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.draft} fixed>{DRAFT_HEADER}</Text>
        <View style={styles.top}>
          <Text style={styles.company}>{companyName}</Text>
          {/* react-pdf Image: a PDF primitive, not an HTML img, so it has no alt attribute. */}
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          {logoSrc ? <Image src={logoSrc} style={styles.logo} /> : null}
        </View>
        <Text style={styles.title}>Gap checklist</Text>
        <Text style={styles.note}>Read from this company&apos;s own Tolra records. Clauses Tolra keeps no records for are always &quot;Not evidenced by Tolra&quot;.</Text>
        <View style={[styles.row, styles.head]} fixed>
          <Text style={styles.clause}>Clause</Text><Text style={styles.requirement}>Requirement</Text><Text style={styles.status}>Status</Text><Text style={styles.basis}>Basis</Text>
        </View>
        {rows.map((r) => (
          <View key={r.clause} style={styles.row} wrap={false}>
            <Text style={styles.clause}>{r.clause}</Text><Text style={styles.requirement}>{r.requirement}</Text><Text style={styles.status}>{gapStatusLabel(r.status)}</Text><Text style={styles.basis}>{r.basis}</Text>
          </View>
        ))}
        <Text style={styles.footer} fixed>{PAGE_FOOTER}</Text>
        <Text style={styles.pageNo} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </Page>
    </Document>
  );
}
