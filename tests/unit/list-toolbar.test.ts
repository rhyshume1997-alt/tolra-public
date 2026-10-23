import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { exportMenuLabels, ListToolbar, type ListToolbarProps } from "@/components/list-toolbar";

const noop = () => {};
const base: ListToolbarProps = { visibleCount: 12, selectedCount: 3, onSelectAll: noop, onClear: noop };
const html = (props: Partial<ListToolbarProps>) => renderToStaticMarkup(createElement(ListToolbar, { ...base, ...props }));
const order = (markup: string, ...texts: string[]) => texts.map((text) => markup.indexOf(text));

describe("ListToolbar", () => {
  it("puts Select all, Clear, the selection text, Print, Export and the page's own action in that order", () => {
    const markup = html({ onPrint: noop, exports: [{ label: "CSV", onSelect: noop }], actions: createElement("button", null, "Pay Selected in Full") });
    const positions = order(markup, "Select all 12 filtered", "Clear selection", "3 selected", "Print Selected", "Export", "Pay Selected in Full");
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("shows the existing selection text", () => {
    expect(html({})).toContain("3 selected</strong> of 12 filtered records");
    expect(html({ visibleCount: 1 })).toContain("of 1 filtered record<");
  });

  it("shows Print only when the page passes a print action", () => {
    expect(html({})).not.toContain("Print");
    expect(html({ onPrint: noop })).toContain("Print Selected");
  });

  it("shows the Export menu only when formats are passed, and lists only those formats in order", () => {
    expect(html({})).not.toContain("Export");
    expect(html({ exports: [] })).not.toContain("Export");
    const markup = html({ exports: [{ label: "CSV", onSelect: noop }, { label: "Excel", onSelect: noop }] });
    expect(markup.match(/Export/g)).toHaveLength(1);
    expect(exportMenuLabels([{ label: "CSV", onSelect: noop }, { label: "Excel", onSelect: noop }])).toEqual(["CSV", "Excel"]);
    expect(exportMenuLabels(undefined)).toEqual([]);
  });

  it("on pages without row selection shows only the Export menu", () => {
    const markup = renderToStaticMarkup(createElement(ListToolbar, { visibleCount: 5, selectedCount: 0, exports: [{ label: "CSV", onSelect: noop }, { label: "Excel", onSelect: noop }] }));
    expect(markup).toContain("Export");
    expect(markup).not.toContain("Select all");
    expect(markup).not.toContain("Clear selection");
    expect(markup).not.toContain("selected");
  });

  it("uses the page's own print label when given", () => {
    expect(html({ onPrint: noop, printLabel: "Print Workshop Pack" })).toContain("Print Workshop Pack");
  });

  it("wraps on a phone rather than scrolling sideways", () => {
    expect(html({})).toContain("flex-wrap");
  });
});
