/** The delivery note PDF (Download, the email attachment, the year-end export) carries the goods-out wording and a Received by / Signature / Date line. */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { DeliveryNotePDF, type DeliveryNotePdfData } from "@/components/pdf/DeliveryNotePDF";
import { JNR_PROFILE } from "@/lib/company";
import { customerSignOffPdfProps } from "@/lib/customer-signoff-print";
import { DELIVERY_NOTE_GOODS_OUT_WORDING } from "@/lib/delivery-note-print";
import { CUSTOMER_SIGNOFF_STATEMENT, type JobSignOff } from "@/lib/job-signoff";
import { pdfText } from "../support/pdf-text";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
const dn: DeliveryNotePdfData = { number: "DLN-0456", taxDate: "07/03/2026", shipDate: "07/03/2026", billTo: ["Example Customer Ltd"], items: [{ description: "Bush", quantity: 2 }], company };
const render = (data: DeliveryNotePdfData) => renderToBuffer(createElement(DeliveryNotePDF, { data }) as Parameters<typeof renderToBuffer>[0]);
const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

describe("delivery note PDF: goods out and received by", () => {
  it("prints the goods-out wording and a blank Received by / Signature / Date line", async () => {
    const out = pdfText(await render(dn));
    expect(out).toContain(DELIVERY_NOTE_GOODS_OUT_WORDING);
    expect(out).toContain("Received by: __________________ Signature: __________________ Date: __________");
  });
  it("a note recorded as signed prints who signed and when", async () => {
    const out = pdfText(await render({ ...dn, signedByName: "A Customer", signedDate: "26/10/2026" }));
    expect(out).toContain("Received by: A Customer   Date: 26/10/2026   Signature: __________________");
  });
  it("uses a company wording when one is passed", async () => {
    const out = pdfText(await render({ ...dn, goodsOutWording: "Goods out in good order, as ticked on the pad." }));
    expect(out).toContain("Goods out in good order, as ticked on the pad.");
    expect(out).not.toContain(DELIVERY_NOTE_GOODS_OUT_WORDING);
  });
  it("still fits one page, with a long list and with a customer sign-off block", async () => {
    const signOff = customerSignOffPdfProps({
      id: "r", job_id: "j", worksheet_version: 2, snapshot: {}, snapshot_sha256: "a".repeat(64), record_sha256: "a".repeat(64), initials: "JS", signer_name: "Jane Smith",
      signed_on: "2026-10-17", signature_kind: "drawn", signature_data: "M10 10L60 40L120 20L200 80", signed_by: "u-1", kind: "customer", created_at: "2026-10-17T13:00:00Z",
      statement: CUSTOMER_SIGNOFF_STATEMENT, device_signed_at: "2026-10-17T13:03:00Z",
    } as JobSignOff);
    const withSignOff = await render({ ...dn, customerSignOff: signOff });
    expect(pages(withSignOff)).toBe(1);
    expect(pdfText(withSignOff)).toContain(DELIVERY_NOTE_GOODS_OUT_WORDING);
    const many = await render({ ...dn, items: Array.from({ length: 8 }, (_, i) => ({ description: `Part ${i + 1}`, quantity: i + 1 })) });
    expect(pages(many)).toBe(1);
  });
});
