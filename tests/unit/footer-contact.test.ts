/** Document footer contact rows (audit D26): only rows with content, real details unchanged. */
import { describe, expect, it } from "vitest";

import { footerContactRows } from "@/lib/company";

const full = { phone: "0100 000 0001", fax: "0100 000 0002", email: "office@example.test", website: "example.test", vatRegistered: true, vatNumber: "GB000000000" };

describe("footerContactRows", () => {
  it("full details: every row as before", () => {
    expect(footerContactRows(full)).toEqual([
      ["Tel/ Fax:", "0100 000 0001/ 0100 000 0002"],
      ["Email:", "office@example.test"],
      ["Website:", "example.test"],
      ["VAT:", "GB000000000"],
    ]);
  });

  it("partial details: no blank labels", () => {
    expect(footerContactRows({ ...full, fax: "", website: " ", vatNumber: "" })).toEqual([["Tel:", "0100 000 0001"], ["Email:", "office@example.test"]]);
    expect(footerContactRows({ ...full, phone: "", email: "" })).toEqual([["Fax:", "0100 000 0002"], ["Website:", "example.test"], ["VAT:", "GB000000000"]]);
  });

  it("nothing set: no rows; not VAT registered: no VAT row", () => {
    expect(footerContactRows({ phone: "", fax: "", email: "", website: "", vatRegistered: true, vatNumber: "" })).toEqual([]);
    expect(footerContactRows({ ...full, vatRegistered: false }).map(([label]) => label)).not.toContain("VAT:");
  });
});
