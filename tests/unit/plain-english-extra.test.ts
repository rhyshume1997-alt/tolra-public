import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostingRatesEditor } from "@/components/costing/costing-rates-editor";
import { PriceThisPart } from "@/components/costing/price-this-part";
import { ChaseSettingsCard } from "@/components/chase/settings-card";
import { CustomerSaysPaid } from "@/components/chase/customer-says-paid";
const rates = { materials: [{ id: "m", name: "Steel", unit: "each" as const, price: 100, scrapPct: 0 }], machines: [{ id: "mill", name: "Mill", hourlyRate: 0 }], labourPerHour: 0, programmingPerHour: 0, overheadPct: 0, marginPct: 20 };
describe("plain words with the same behaviour", () => {
  it("describes the actual markup maths rather than promising gross margin", () => {
    const html = renderToStaticMarkup(createElement(CostingRatesEditor, { value: rates, onChange: () => {} }));
    expect(html).toContain("Profit added %"); expect(html).toContain("£120"); expect(html).not.toContain("£125");
  });
  it("labels the actual quote line price as before VAT", () => {
    const html = renderToStaticMarkup(createElement(PriceThisPart, { rates, onAdd: () => {} }));
    expect(html).toContain("Quote line total before VAT: £120.00");
  });
  it("retains the approval note and explains signed days", () => {
    const html = renderToStaticMarkup(createElement(ChaseSettingsCard, { initialSteps: [{ days: -3, tone: "before_due" }], onSave: () => {} }));
    expect(html).toContain("Chasers are drafts for approval."); expect(html).toContain("Days before or after due date");
  });
  it("keeps the payment check distinct from recording receipt", () => {
    const html = renderToStaticMarkup(createElement(CustomerSaysPaid, { invoiceId: "i", invoiceNumber: "INV-1", paymentToConfirm: true, onCustomerSaysPaid: () => {}, onConfirmPaymentReceived: () => {}, onNotReceivedResumeChasing: () => {} }));
    expect(html).toContain("This does not mean the payment has been received.");
  });
});
