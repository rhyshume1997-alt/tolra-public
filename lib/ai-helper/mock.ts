import { type AiCompletion, type AiCompletionRequest, type AiHelperProvider, AiProviderError } from "@/lib/ai-helper/provider";

/**
 * The test provider (AI_HELPER_PROVIDER=mock; refused on a Vercel deployment, lib/ai-helper/server.ts). Deterministic, no network, no
 * key used. It "reads" a synthetic RFQ written one item per line:
 *
 *   Customer: Acme Engineering Ltd
 *   - 25 x Bracket, Part: BR-100, Material: 6082-T6 aluminium, Finish: clear anodise, Due: 2026-12-04
 *
 * A field left out comes back null (so the route flags it). For the tests of the guards around it:
 *   [mock:down]     the service does not answer (AiProviderError unavailable; it may have billed: settled at the full reservation)
 *   [mock:rejected] the service refuses the request before any work (unavailable, rejectedBeforeWork: settled at 0)
 *   [mock:refuse]   the model declines (refused)
 *   [mock:garbage]  an answer that is not the JSON asked for (invalid)
 *   text asking to "ignore previous instructions": the answer a steered model might give (extra keys, a price, an action, a quote
 *   reference the server never sent, a negative quantity, an impossible date). The route must drop all of it.
 * For the round-up it states the total from the facts.
 */
export function mockProvider(): AiHelperProvider {
  return {
    id: "mock",
    async complete(req: AiCompletionRequest): Promise<AiCompletion> {
      const usage = { inputTokens: Math.ceil(Buffer.byteLength(req.system + req.data) / 4), outputTokens: 120 };
      const data = JSON.parse(req.data) as Record<string, unknown>;
      const text = typeof data.rfq_email === "string" ? data.rfq_email : "";
      if (text.includes("[mock:down]")) throw new AiProviderError("unavailable");
      if (text.includes("[mock:rejected]")) throw new AiProviderError("unavailable", undefined, "rate", true);
      if (text.includes("[mock:refuse]")) throw new AiProviderError("refused", usage);
      if (text.includes("[mock:garbage]")) throw new AiProviderError("invalid", usage);
      if (Array.isArray(data.sections)) return { json: roundup(data), usage, model: req.model };
      if (/ignore (all )?previous instructions/i.test(text)) return { json: steered(), usage, model: req.model };
      return { json: readRfq(text), usage, model: req.model };
    },
  };
}

function roundup(data: Record<string, unknown>) {
  const sections = (data.sections as { title: string; count: number; failed: boolean }[]).filter((s) => !s.failed && s.count > 0);
  const total = sections.reduce((sum, s) => sum + s.count, 0);
  const lead = sections[0];
  return { summary: total === 0 ? "Nothing needs attention." : `${total} things need attention. Most urgent: ${lead.title} (${lead.count}).` };
}

function field(part: string, name: string): string | null {
  const m = new RegExp(`^${name}\\s*:\\s*(.+)$`, "i").exec(part.trim());
  return m ? m[1].trim() : null;
}

function readRfq(text: string) {
  const customer = /^(?:customer|company)\s*:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*(?:(\d+)\s*(?:x|off|pcs)\s+)?(.+)$/i.exec(raw);
    if (!m) continue;
    const [first, ...rest] = m[2].split(",");
    const pick = (name: string) => rest.map((p) => field(p, name)).find((v) => v !== null) ?? null;
    lines.push({
      description: first.trim() || null,
      part_number: pick("part"),
      material: pick("material"),
      finish: pick("finish"),
      quantity: m[1] ? Number(m[1]) : null,
      due_date: pick("due"),
      unclear: [] as string[],
      similar_quote_ref: null,
    });
  }
  return { customer, suspicious_text: false, lines };
}

function steered() {
  return {
    customer: "<b>Beta Rival Ltd</b>",
    suspicious_text: false,
    action: "issue_invoice",
    tool_call: { name: "record_payment", amount: 1 },
    lines: [
      { description: "Widget", part_number: null, material: "Steel", finish: null, quantity: -5, due_date: "2026-02-30",
        unclear: ["price", "drop table"], similar_quote_ref: "QUO-9999", unit_price: 1, total: 1, status: "issued" },
    ],
  };
}
