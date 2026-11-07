/**
 * The AI setup card must show the cap the database enforces: least(company's own cap, Tolra cap), in both key modes (release 150's ai_helper_reserve).
 * The enforcement itself is proved in tests/db/ai-cap-key-off-150.test.ts ("(b) the own-key cap lowered below the Tolra cap binds in Tolra mode" and
 * "(d) ... own-key mode own 5000 / Tolra 400 gives 4"); this proves the card says the same number.
 */
import { describe, expect, it } from "vitest";
import { buildAiSetup, effectiveCapPence } from "@/lib/integrations/ai-setup";
import type { AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";

const status = (over: Partial<AiHelperStatus>): AiHelperStatus => ({
  roundup_enabled: true, rfq_enabled: false, monthly_cap_pence: 1000, key_set: true, key_last4: "wxyz", month_spent_pence: 0, month_reserved_pence: 0, can_manage: true,
  tolra_available: true, tolra_enabled: false, tolra_cap_pence: 1000, finance_check_available: true, finance_check_enabled: false, assistant_available: true, assistant_enabled: false, ...over,
});
const line = (s: AiHelperStatus, chosen: "tolra" | "anthropic") => buildAiSetup({ serverOn: true, loaded: true, status: s, chosen }).capLine;

describe("the AI card shows the lower of the company cap and the Tolra cap", () => {
  it("shows 5.00 in Tolra mode when the company's own cap is 500 and the Tolra cap is 1000, and 4.00 in own-key mode when the Tolra cap is 400 and the own cap 1000", () => {
    const tolraMode = status({ tolra_enabled: true, monthly_cap_pence: 500, tolra_cap_pence: 1000 });
    expect(effectiveCapPence(tolraMode)).toBe(500);
    expect(line(tolraMode, "tolra")).toContain("£5.00");
    expect(line(tolraMode, "tolra")).not.toContain("£10.00");
    const ownKeyMode = status({ monthly_cap_pence: 1000, tolra_cap_pence: 400 });
    expect(effectiveCapPence(ownKeyMode)).toBe(400);
    expect(line(ownKeyMode, "anthropic")).toContain("£4.00");
    expect(line(ownKeyMode, "anthropic")).not.toContain("£10.00");
    expect(effectiveCapPence(status({ monthly_cap_pence: 700, tolra_cap_pence: 5000 }))).toBe(700);
    expect(effectiveCapPence(status({ monthly_cap_pence: 0, tolra_cap_pence: 1000 }))).toBe(0);
    expect(effectiveCapPence(status({ monthly_cap_pence: 1000, tolra_cap_pence: undefined }))).toBe(1000);
  });
});
