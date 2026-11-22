import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import { CustomerSignOffBlock, type PdfDocumentData } from "@/components/pdf/BaseDocumentPDF";
import { brandColour, buildDocumentModel, inkOn } from "@/components/pdf/templates/document-model";

/**
 * Design "modern" (module J): the company's brand colour in the title, a rule and the table heading, logo top left, key details beside
 * the title, soft row lines. Inputs: a PdfDocumentData. Output: a react-pdf <Document>. Everything printed comes from buildDocumentModel
 * (components/pdf/templates/document-model.ts), so figures, VAT, totals, bank details, payment wording and numbering equal every other design.
 * Must not change: it must not work out or reword any amount, label or document number itself.
 */
const MUTED = "#5b6470";
const LINE = "#d9dde3";
const NUMERIC_WIDTH: Record<string, number> = { Qty: 54, Each: 62, "VAT%": 46, Total: 70 };

const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 120, paddingHorizontal: 36, fontFamily: "Helvetica", fontSize: 9, color: "#111827" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  brandBlock: { width: 230 },
  logo: { maxWidth: 170, maxHeight: 64, objectFit: "contain", objectPositionX: 0 },
  name: { fontFamily: "Helvetica-Bold", fontSize: 16 },
  titleBlock: { width: 250, alignItems: "flex-end" },
  title: { fontFamily: "Helvetica-Bold", fontSize: 22, textAlign: "right" },
  kvRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 3 },
  kvLabel: { color: MUTED, fontSize: 8.5, marginRight: 6 },
  kvValue: { fontFamily: "Helvetica-Bold", fontSize: 9 },
  rule: { height: 2, marginTop: 14, marginBottom: 14 },
  addresses: { flexDirection: "row", marginBottom: 16 },
  addressCol: { width: "50%", paddingRight: 12 },
  addressLabel: { fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 },
  addressLine: { fontSize: 9, lineHeight: 1.3 },
  headRow: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 6 },
  headText: { fontFamily: "Helvetica-Bold", fontSize: 8.5 },
  row: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 6, borderBottomWidth: 0.6, borderBottomColor: LINE },
  desc: { fontSize: 9, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, paddingRight: 8, lineHeight: 1.3 },
  num: { textAlign: "right" },
  bottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 16 },
  left: { width: 300 },
  heading: { fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 },
  messageLine: { fontSize: 9, marginBottom: 4, lineHeight: 1.3 },
  paymentRow: { flexDirection: "row", marginBottom: 2 },
  paymentLabel: { width: 82, fontFamily: "Helvetica-Bold" },
  totals: { width: 190 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  totalBold: { fontFamily: "Helvetica-Bold" },
  footer: { position: "absolute", left: 36, right: 36, bottom: 30, borderTopWidth: 0.6, borderTopColor: LINE, paddingTop: 6 },
  footerCols: { flexDirection: "row", justifyContent: "space-between" },
  footerText: { fontSize: 8, color: MUTED, lineHeight: 1.3 },
  watermark: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  watermarkText: { fontFamily: "Helvetica-Bold", fontSize: 150, color: "#00ff00", opacity: 0.35, transform: "rotate(45deg)" },
});

export function ModernDocument({ data }: { data: PdfDocumentData }) {
  const m = buildDocumentModel(data);
  const brand = brandColour(m.company);
  const widthOf = (heading: string, index: number) => (index === 0 ? undefined : NUMERIC_WIDTH[heading] ?? 70);
  const cell = (index: number, heading: string) => (index === 0 ? s.desc : [s.num, { width: widthOf(heading, index) }]);
  return (
    <Document title={`${m.title} ${m.documentNumber}`} author={m.company.name} creator={m.company.name}>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View style={s.brandBlock}>
            {/* react-pdf Image: a PDF primitive, not an HTML img, so it has no alt attribute. */}
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            {m.logo ? <Image src={m.logo} style={s.logo} /> : <Text style={[s.name, { color: brand }]}>{m.company.name}</Text>}
          </View>
          <View style={s.titleBlock}>
            <Text style={[s.title, { color: brand }]}>{m.title.toUpperCase()}</Text>
            {m.keyValues.map((row, index) => (
              <View key={`${row.label}-${index}`} style={s.kvRow}><Text style={s.kvLabel}>{row.label}</Text><Text style={s.kvValue}>{row.value}</Text></View>
            ))}
          </View>
        </View>
        <View style={[s.rule, { backgroundColor: brand }]} />

        <View style={s.addresses}>
          <View style={s.addressCol}>
            <Text style={[s.addressLabel, { color: brand }]}>{m.billToLabel}</Text>
            {m.billTo.map((line, index) => <Text key={`${line}-${index}`} style={s.addressLine}>{line}</Text>)}
          </View>
          <View style={s.addressCol}>
            <Text style={[s.addressLabel, { color: brand }]}>{m.deliverToLabel}</Text>
            {m.deliverTo.map((line, index) => <Text key={`${line}-${index}`} style={s.addressLine}>{line}</Text>)}
          </View>
        </View>

        <View style={[s.headRow, { backgroundColor: brand }]} fixed>
          {m.heads.map((heading, index) => (
            <Text key={heading} style={[s.headText, { color: inkOn(brand) }, index === 0 ? { flexGrow: 1, flexShrink: 1, flexBasis: 0 } : { width: widthOf(heading, index), textAlign: "right" }]}>{heading}</Text>
          ))}
        </View>
        {m.rows.map((cells, rowIndex) => (
          <View key={rowIndex} style={s.row} wrap={false}>
            {cells.map((value, index) => <Text key={index} style={cell(index, m.heads[index])}>{value}</Text>)}
          </View>
        ))}

        <View style={s.bottom} wrap={false}>
          <View style={s.left}>
            <Text style={[s.heading, { color: brand }]}>{m.messageTitle}</Text>
            {m.message.map((line, index) => <Text key={`${line}-${index}`} style={s.messageLine}>{line}</Text>)}
            {m.paymentDetails.length ? (
              <View style={{ marginTop: 8 }}>
                <Text style={[s.heading, { color: brand }]}>Payment details</Text>
                {m.paymentDetails.map((row) => <View key={row.label} style={s.paymentRow}><Text style={s.paymentLabel}>{row.label}</Text><Text>{row.value}</Text></View>)}
              </View>
            ) : null}
            {m.customerSignOff ? <CustomerSignOffBlock signOff={m.customerSignOff} /> : null}
            {m.closingLines.length ? <View style={{ marginTop: 8 }} wrap={false}>{m.closingLines.map((line, index) => <Text key={`${line}-${index}`} style={{ marginBottom: 4 }}>{line}</Text>)}</View> : null}
          </View>
          {m.priced ? (
            <View style={s.totals}>
              {m.totalRows.map((row, index) => (
                <View key={`${row.label}-${index}`} style={[s.totalRow, index === m.totalRows.length - 1 ? { borderTopWidth: 1.5, borderTopColor: brand, marginTop: 3, paddingTop: 5 } : {}]}>
                  <Text style={s.totalBold}>{row.label}</Text>
                  <Text style={row.bold ? s.totalBold : {}}>{row.value}</Text>
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
