import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import { CustomerSignOffBlock, type PdfDocumentData } from "@/components/pdf/BaseDocumentPDF";
import { buildDocumentModel } from "@/components/pdf/templates/document-model";

/**
 * Design "minimal" (module J): black on white with plenty of space, the brand colour only on the title, a short rule under it and the
 * closing total. No boxes; the table has hairlines between rows only. Inputs: a PdfDocumentData. Output: a react-pdf <Document>.
 * Everything printed comes from buildDocumentModel (components/pdf/templates/document-model.ts), so figures, VAT, totals, bank details,
 * payment wording and numbering equal every other design.
 * Must not change: it must not work out or reword any amount, label or document number itself.
 */
const MUTED = "#6b7280";
const HAIR = "#e5e7eb";
const NUMERIC_WIDTH: Record<string, number> = { Qty: 54, Each: 62, "VAT%": 46, Total: 70 };

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 120, paddingHorizontal: 44, fontFamily: "Helvetica", fontSize: 9, color: "#111111" },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  logo: { maxWidth: 150, maxHeight: 56, objectFit: "contain", objectPositionX: 0 },
  name: { fontFamily: "Helvetica-Bold", fontSize: 14 },
  title: { fontSize: 20, textAlign: "right", letterSpacing: 2 },
  titleRule: { width: 36, height: 2, alignSelf: "flex-end", marginTop: 6 },
  details: { flexDirection: "row", flexWrap: "wrap", marginTop: 22, marginBottom: 22 },
  detail: { width: "25%", marginBottom: 8, paddingRight: 8 },
  detailLabel: { color: MUTED, fontSize: 7.5, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 },
  addresses: { flexDirection: "row", marginBottom: 22 },
  addressCol: { width: "50%", paddingRight: 16 },
  addressLabel: { color: MUTED, fontSize: 7.5, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  addressLine: { fontSize: 9, lineHeight: 1.35 },
  headRow: { flexDirection: "row", paddingBottom: 5, borderBottomWidth: 0.8, borderBottomColor: "#111111" },
  headText: { fontFamily: "Helvetica-Bold", fontSize: 8 },
  row: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: HAIR },
  desc: { fontSize: 9, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, paddingRight: 10, lineHeight: 1.35 },
  num: { textAlign: "right" },
  bottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 20 },
  left: { width: 290 },
  heading: { color: MUTED, fontSize: 7.5, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  line: { fontSize: 9, marginBottom: 4, lineHeight: 1.35 },
  paymentRow: { flexDirection: "row", marginBottom: 2 },
  paymentLabel: { width: 82, color: MUTED },
  totals: { width: 180 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  footer: { position: "absolute", left: 44, right: 44, bottom: 32 },
  footerText: { fontSize: 7.5, color: MUTED, lineHeight: 1.35 },
  footerCols: { flexDirection: "row", justifyContent: "space-between" },
  watermark: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  watermarkText: { fontFamily: "Helvetica-Bold", fontSize: 150, color: "#00ff00", opacity: 0.3, transform: "rotate(45deg)" },
});

export function MinimalDocument({ data }: { data: PdfDocumentData }) {
  const m = buildDocumentModel(data);
  const brand = m.accent;
  const widthOf = (heading: string) => NUMERIC_WIDTH[heading] ?? 70;
  return (
    <Document title={`${m.title} ${m.documentNumber}`} author={m.company.name} creator={m.company.name}>
      <Page size="A4" style={s.page}>
        <View style={s.top}>
          <View>
            {/* react-pdf Image: a PDF primitive, not an HTML img, so it has no alt attribute. */}
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            {m.logo ? <Image src={m.logo} style={s.logo} /> : <Text style={s.name}>{m.company.name}</Text>}
          </View>
          <View>
            <Text style={[s.title, { color: brand }]}>{m.title.toUpperCase()}</Text>
            <View style={[s.titleRule, { backgroundColor: brand }]} />
          </View>
        </View>

        <View style={s.details}>
          {m.keyValues.map((row, index) => (
            <View key={`${row.label}-${index}`} style={s.detail}><Text style={s.detailLabel}>{row.label}</Text><Text>{row.value}</Text></View>
          ))}
        </View>

        <View style={s.addresses}>
          <View style={s.addressCol}>
            <Text style={s.addressLabel}>{m.billToLabel}</Text>
            {m.billTo.map((line, index) => <Text key={`${line}-${index}`} style={s.addressLine}>{line}</Text>)}
          </View>
          <View style={s.addressCol}>
            <Text style={s.addressLabel}>{m.deliverToLabel}</Text>
            {m.deliverTo.map((line, index) => <Text key={`${line}-${index}`} style={s.addressLine}>{line}</Text>)}
          </View>
        </View>

        <View style={s.headRow} fixed>
          {m.heads.map((heading, index) => (
            <Text key={heading} style={[s.headText, index === 0 ? { flexGrow: 1, flexShrink: 1, flexBasis: 0 } : { width: widthOf(heading), textAlign: "right" }]}>{heading}</Text>
          ))}
        </View>
        {m.rows.map((cells, rowIndex) => (
          <View key={rowIndex} style={s.row} wrap={false}>
            {cells.map((value, index) => <Text key={index} style={index === 0 ? s.desc : [s.num, { width: widthOf(m.heads[index]) }]}>{value}</Text>)}
          </View>
        ))}

        <View style={s.bottom} wrap={false}>
          <View style={s.left}>
            <Text style={s.heading}>{m.messageTitle}</Text>
            {m.message.map((line, index) => <Text key={`${line}-${index}`} style={s.line}>{line}</Text>)}
            {m.paymentDetails.length ? (
              <View style={{ marginTop: 10 }}>
                <Text style={s.heading}>Payment details</Text>
                {m.paymentDetails.map((row) => <View key={row.label} style={s.paymentRow}><Text style={s.paymentLabel}>{row.label}</Text><Text>{row.value}</Text></View>)}
              </View>
            ) : null}
            {m.customerSignOff ? <CustomerSignOffBlock signOff={m.customerSignOff} /> : null}
            {m.closingLines.length ? <View style={{ marginTop: 10 }} wrap={false}>{m.closingLines.map((line, index) => <Text key={`${line}-${index}`} style={s.line}>{line}</Text>)}</View> : null}
          </View>
          {m.priced ? (
            <View style={s.totals}>
              {m.totalRows.map((row, index) => (
                <View key={`${row.label}-${index}`} style={s.totalRow}>
                  <Text style={{ color: row.bold ? brand : MUTED, fontFamily: row.bold ? "Helvetica-Bold" : "Helvetica" }}>{row.label}</Text>
                  <Text style={row.bold ? { fontFamily: "Helvetica-Bold", color: brand } : {}}>{row.value}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        <View style={s.footer} fixed>
          <View style={s.footerCols}>
            <View>
              <Text style={[s.footerText, { fontFamily: "Helvetica-Bold" }]}>{m.company.documentName}</Text>
              {m.company.addressLines.map((line, index) => <Text key={`${line}-${index}`} style={s.footerText}>{line}</Text>)}
            </View>
            <View>{m.footerContacts.map(([label, value]) => <Text key={label} style={s.footerText}>{`${label} ${value}`}</Text>)}</View>
          </View>
        </View>
        {m.paidWatermark ? <View style={s.watermark} fixed><Text style={s.watermarkText}>PAID</Text></View> : null}
      </Page>
    </Document>
  );
}
