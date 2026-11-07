import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The "sent out" delivery note set is hard-coded in several TS places; they must all be exactly despatched / delivered / signed.
const WANT = ["delivered", "despatched", "signed"];
const grab = (file: string, anchor: string) => {
  const src = readFileSync(file, "utf8"); const at = src.indexOf(anchor); if (at < 0) throw new Error(`${anchor} missing in ${file}`);
  const open = src.indexOf("[", at); return [...src.slice(open, src.indexOf("]", open)).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
};
describe("sm-c: delivery-note 'sent out' set", () => {
  it.each([
    ["lib/people.ts", 'if (["despatched"'],
    ["lib/attention-items.ts", '!["despatched"'],
    ["lib/list-filter.ts", 'return ["despatched"'],
    ["lib/ai/finance-check/check.ts", "const DESPATCHED"],
  ])("%s", (file, anchor) => expect(grab(file, anchor)).toEqual(WANT));
  it("delivery-notes page sentOut", () => {
    const src = readFileSync("app/(dashboard)/delivery-notes/page.tsx", "utf8");
    const line = src.split("\n").find((l) => l.includes("const sentOut"))!;
    expect([...line.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual(WANT);
  });
  it("attention-load (awaiting + sent out) is awaiting plus the same set", () => {
    const src = readFileSync("lib/attention-load.ts", "utf8");
    expect(src).toContain('["awaiting", "despatched", "delivered", "signed"]');
  });
});
