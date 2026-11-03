import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const read=(p:string)=>readFileSync(p,"utf8");
it("runs all reviewer cases explicitly in integration with a required database",()=>{
 const ci=read('.github/workflows/ci.yml');const block=ci.split('- name: Reviewer browser conditions')[1]?.split('- name: Keep run evidence')[0];
 expect(block).toBeDefined();expect(block).toContain('REVIEWER_REQUIRE_DATABASE=1 E2E_SKIP_BUILD=1 npx playwright test -c playwright.reviewer.config.ts');
 expect(block).not.toContain('continue-on-error');expect(block).toContain('!cancelled()');
 expect(read('playwright.reviewer.config.ts')).toContain('testIgnore: []');
 expect(read('playwright.reviewer.config.ts')).toContain('requireBrowserDatabase(configured, process.env.REVIEWER_REQUIRE_DATABASE === "1")');
 expect(read('playwright.config.ts')).toContain('testIgnore: ["**/reviewer/**"]');
});
