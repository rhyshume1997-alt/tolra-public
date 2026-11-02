/**
 * lib/po-capture (migration 125): PO numbers found in real-looking e-mails, false positives (dates, phone numbers, VAT numbers, postcodes,
 * PO Box, our own document numbers, quantities) refused, and the suggestion rules: the sender AND a PO number, never one alone.
 */
import { describe, expect, it } from "vitest";

import {
  AUTO_LINK_ENABLED, MAX_SUGGESTIONS, type PurchaseOrderCandidate, type QuoteCandidate, emailList, extractPoNumbers, matchInboundEmail, normalisePo,
  plausiblePo, quoteRefsIn, senderMatches,
} from "@/lib/po-capture";

const pos = (subject: string, bodyText = "", attachmentNames: string[] = []) => extractPoNumbers({ fromAddress: null, subject, bodyText, attachmentNames }).map((p) => p.value);

describe("PO numbers found", () => {
  it.each([
    ["PO 4471 attached", "", ["4471"]],
    ["Purchase order 4471", "", ["4471"]],
    ["Our PO number: 4471", "", ["4471"]],
    ["P.O. No. 4471-A", "", ["4471-A"]],
    ["", "Please find attached our purchase order no. 77812 for the brackets.", ["77812"]],
    ["", "Order No: 450012345\nDelivery to Unit 4", ["450012345"]],
    ["Order number 00451", "", ["00451"]],
    ["Your ref: AB12345", "", ["AB12345"]],
    ["PO4471", "", ["PO4471"]],
    ["Re: PO-0007 delivery", "", ["PO-0007"]],
    ["", "Delivery note for your order PO-0012, 3 of 5 sent", ["PO-0012"]],
    ["Order # 123/456", "", ["123/456"]],
    ["RE: QUO-0012 - PO 4471", "", ["4471"]],
    ["purchase order 4471", "PO 4471 again in the body", ["4471"]],
    ["PO: 4471. Thanks", "", ["4471"]],
    ["Ref no: 98123", "", ["98123"]],
    ["", "Hi John,\r\n\r\nPO number is 55120\r\n\r\nRegards", ["55120"]],
  ])("%s / %s -> %j", (subject, body, want) => {
    expect(pos(subject, body)).toEqual(want);
  });

  it("attachment file names (when given) count; the contents are never read", () => {
    expect(pos("Order", "", ["PO_88123.pdf"])).toEqual(["88123"]);
    expect(extractPoNumbers({ fromAddress: null, subject: "x", bodyText: "", attachmentNames: ["PO_88123.pdf"] })[0].source).toBe("attachment");
  });

  it("several different POs are each listed once, in order", () => {
    expect(pos("PO 4471 and PO 4472", "PO 4471 PO-4471")).toEqual(["4471", "4472"]);
  });

  it("gives a short snippet around the match", () => {
    const [po] = extractPoNumbers({ fromAddress: null, subject: "", bodyText: `${"x ".repeat(80)}Please find our PO 4471 attached for the brackets. ${"y ".repeat(80)}` });
    expect(po.snippet).toContain("PO 4471");
    expect(po.snippet.length).toBeLessThanOrEqual(200);
  });
});

describe("false positives refused", () => {
  it.each([
    ["Order 500 brackets", ""],
    ["PO Box 1234, Glasgow", ""],
    ["P.O. Box 77", ""],
    ["Portsmouth PO12 3AB", ""],
    ["Delivery address PO1 2AB", ""],
    ["Purchase order dated 12/05/2026", ""],
    ["PO 12/05/2026", ""],
    ["PO 2026-05-12", ""],
    ["PO tel 01698 000 0003", ""],
    ["PO: 01698000003", ""],
    ["PO 07700900123", ""],
    ["PO +447700900123", ""],
    ["VAT reg GB123456789", ""],
    ["PO GB123456789", ""],
    ["Our ref QUO-0012", ""],
    ["Your ref INV-0045", ""],
    ["Ref: DLN-0003", ""],
    ["PO 7", ""],
    ["PO value £4,471.00", ""],
    ["Order now while stocks last", ""],
    ["Purchase order to follow", ""],
    ["The PO is attached", ""],
    ["Company no 01234567, VAT no 123 4567 89", ""],
    ["Meeting at 12:30 to discuss the order", ""],
    ["Call 0141 496 0000 about the RFQ", "Phone: 01698 000 0004\nFax 0141 496 0001"],
  ])("%s", (subject, body) => {
    expect(pos(subject, body)).toEqual([]);
  });

  it("plausiblePo rejects short, digitless, date, phone and VAT shapes", () => {
    for (const bad of ["AB", "ABC", "12", "1/2/26", "01698000003", "GB123456789", "QUO-0012", "J-0042"]) expect(plausiblePo(bad)).toBe(false);
    for (const good of ["4471", "AB12345", "PO-0007", "450012345"]) expect(plausiblePo(good)).toBe(true);
  });
});

describe("normalising and senders", () => {
  it("compares without case, spaces, hyphens, dots, slashes or a leading PO", () => {
    expect(normalisePo(" po-44 71 ")).toBe("4471");
    expect(normalisePo("P.O.4471")).toBe("4471");
    expect(normalisePo("PO-0007")).toBe(normalisePo("po 0007"));
    expect(normalisePo("POL123")).toBe("POL123");
  });
  it("matches the same address or the same company domain, never a shared mail domain", () => {
    expect(senderMatches("Buyer@Acme.example", ["buyer@acme.example"])).toBe("address");
    expect(senderMatches("other@acme.example", ["buyer@acme.example"])).toBe("domain");
    expect(senderMatches("someone@aol.com", ["buyer@aol.com"])).toBeNull();
    expect(senderMatches("buyer@aol.com", ["Buyer@aol.com"])).toBe("address");
    expect(senderMatches("x@evil.example", ["buyer@acme.example"])).toBeNull();
    expect(senderMatches(null, ["buyer@acme.example"])).toBeNull();
    expect(senderMatches("x@acme.example.evil.example", ["buyer@acme.example"])).toBeNull();
  });
  it("reads several stored addresses", () => {
    expect(emailList("a@x.example; B@x.example, not-an-address")).toEqual(["a@x.example", "b@x.example"]);
  });
  it("finds our quote numbers", () => {
    expect([...quoteRefsIn({ fromAddress: null, subject: "Re: QUO-0012 and quo 0013", bodyText: "QUO0014" })]).toEqual(["QUO0012", "QUO0013", "QUO0014"]);
  });
});

const quote = (over: Partial<QuoteCandidate> = {}): QuoteCandidate => ({ id: "q1", ref: "QUO-0012", status: "sent", customer: "Acme Ltd", customerPo: null, customerEmails: ["buyer@acme.example"], ...over });
const order = (over: Partial<PurchaseOrderCandidate> = {}): PurchaseOrderCandidate => ({ id: "p1", ref: "PO-0007", status: "sent", supplier: "Steel Co", supplierEmails: ["sales@steel.example"], ...over });
const match = (email: { from: string; subject: string; body?: string }, quotes: QuoteCandidate[] = [], purchaseOrders: PurchaseOrderCandidate[] = []) =>
  matchInboundEmail({ fromAddress: email.from, subject: email.subject, bodyText: email.body ?? "" }, { quotes, purchaseOrders }).suggestions;

describe("suggestions: the sender AND a PO number", () => {
  it("automatic linking is off", () => {
    expect(AUTO_LINK_ENABLED).toBe(false);
  });

  it("the customer's PO equals the quote's customer PO (123), from the customer: suggested", () => {
    const s = match({ from: "buyer@acme.example", subject: "PO 4471 delivery date" }, [quote({ customerPo: "PO-4471" })]);
    expect(s).toEqual([expect.objectContaining({ kind: "quote", id: "q1", ref: "QUO-0012", po: "4471" })]);
  });

  it("the same PO from a stranger: nothing (never on the PO number alone)", () => {
    expect(match({ from: "x@other.example", subject: "PO 4471" }, [quote({ customerPo: "4471" })])).toEqual([]);
    expect(match({ from: "x@aol.com", subject: "PO 4471" }, [quote({ customerPo: "4471", customerEmails: ["buyer@aol.com"] })])).toEqual([]);
  });

  it("the customer with no PO number in the e-mail: nothing (never on the sender alone)", () => {
    expect(match({ from: "buyer@acme.example", subject: "Re: QUO-0012 thanks, order to follow" }, [quote()])).toEqual([]);
  });

  it("a quote with a different customer PO is not suggested", () => {
    expect(match({ from: "buyer@acme.example", subject: "PO 9999" }, [quote({ customerPo: "4471" })])).toEqual([]);
  });

  it("names the quote and gives a PO, from the customer's domain: suggested with that PO", () => {
    const s = match({ from: "accounts@acme.example", subject: "Order for QUO-0012", body: "Our purchase order number is 77812." }, [quote()]);
    expect(s).toEqual([expect.objectContaining({ id: "q1", po: "77812" })]);
  });

  it("several of the customer's quotes: all listed, the named one first, for John to choose", () => {
    const s = match({ from: "buyer@acme.example", subject: "PO 4471 for QUO-0013" }, [quote(), quote({ id: "q2", ref: "QUO-0013" }), quote({ id: "q3", ref: "QUO-0014", status: "accepted" })]);
    expect(s.map((x) => x.ref)).toEqual(["QUO-0013", "QUO-0012"]);
  });

  it("draft, rejected and superseded quotes are never suggested", () => {
    for (const status of ["draft", "rejected", "superseded"]) expect(match({ from: "buyer@acme.example", subject: "PO 4471 QUO-0012" }, [quote({ status })])).toEqual([]);
  });

  it("our own quote number is never taken as the customer's PO", () => {
    expect(match({ from: "buyer@acme.example", subject: "Your ref: QUO-0012" }, [quote()])).toEqual([]);
  });

  it("supplier document: our PO number, from the supplier's domain: suggested", () => {
    const s = match({ from: "despatch@steel.example", subject: "Delivery note for your PO-0007" }, [], [order()]);
    expect(s).toEqual([expect.objectContaining({ kind: "purchase_order", id: "p1", ref: "PO-0007", po: "PO-0007" })]);
  });

  it("supplier document from someone else, or a supplier with no address on file: nothing", () => {
    expect(match({ from: "x@other.example", subject: "PO-0007" }, [], [order()])).toEqual([]);
    expect(match({ from: "sales@steel.example", subject: "PO-0007" }, [], [order({ supplierEmails: [] })])).toEqual([]);
  });

  it("a draft purchase order is never suggested", () => {
    expect(match({ from: "sales@steel.example", subject: "PO-0007" }, [], [order({ status: "draft" })])).toEqual([]);
  });

  it("at most MAX_SUGGESTIONS", () => {
    const many = Array.from({ length: 15 }, (_, i) => quote({ id: `q${i}`, ref: `QUO-${String(i).padStart(4, "0")}` }));
    expect(match({ from: "buyer@acme.example", subject: "PO 4471" }, many)).toHaveLength(MAX_SUGGESTIONS);
  });

  it("no PO number: no work at all", () => {
    expect(matchInboundEmail({ fromAddress: "buyer@acme.example", subject: "RFQ: 50 brackets", bodyText: "Drawing attached, call 01698 000 0003" }, { quotes: [quote()], purchaseOrders: [order()] })).toEqual({ poNumbers: [], suggestions: [] });
  });
});
