import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmptyList } from "@/components/empty-list";
import {
  customersEmptyHint, deliveryNotesEmptyHint, invoicesEmptyHint, purchaseOrdersEmptyHint, quotesEmptyHint,
  rfqEmptyHint, salesOrdersEmptyHint, suppliersEmptyHint, usersEmptyHint,
} from "@/lib/empty-hints";

describe("empty list sentences", () => {
  it("each says which button to press, using the button's own name", () => {
    expect(quotesEmptyHint()).toContain("New quote");
    expect(salesOrdersEmptyHint()).toContain("New sales order");
    expect(purchaseOrdersEmptyHint()).toContain("New purchase order");
    expect(deliveryNotesEmptyHint()).toContain("New delivery note");
    expect(invoicesEmptyHint()).toContain("New invoice");
    expect(rfqEmptyHint()).toContain("New RFQ");
    expect(customersEmptyHint()).toContain("New customer");
    expect(suppliersEmptyHint()).toContain("New supplier");
    expect(usersEmptyHint()).toContain("New user");
  });

  it("each is one short sentence", () => {
    for (const hint of [quotesEmptyHint(), salesOrdersEmptyHint(), purchaseOrdersEmptyHint(), deliveryNotesEmptyHint(), invoicesEmptyHint(), rfqEmptyHint(), customersEmptyHint(), suppliersEmptyHint(), usersEmptyHint()]) {
      expect(hint.split(". ").length).toBe(1);
      expect(hint.length).toBeLessThan(110);
      expect(hint.endsWith(".")).toBe(true);
    }
  });
});

describe("EmptyList", () => {
  it("shows what is missing, what to do next and the action", () => {
    const html = renderToStaticMarkup(createElement(EmptyList, { title: "No quotes yet", hint: quotesEmptyHint(), hintTestId: "empty-hint", action: createElement("button", null, "New quote") }));
    expect(html).toContain("No quotes yet");
    expect(html).toContain('data-testid="empty-hint"');
    expect(html).toContain("Press New quote to make your first one.");
    expect(html).toContain("<button>New quote</button>");
  });

  it("works with no action and no test id", () => {
    const html = renderToStaticMarkup(createElement(EmptyList, { title: "No RFQs match this filter", hint: "Try a different filter." }));
    expect(html).toContain("Try a different filter.");
    expect(html).not.toContain("data-testid");
  });
});
