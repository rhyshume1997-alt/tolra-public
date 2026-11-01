import { type AiCompletion, type AiCompletionRequest, type AiHelperProvider, AiProviderError } from "@/lib/ai-helper/provider";

/**
 * The test provider (AI_HELPER_PROVIDER=mock; refused on a Vercel deployment, lib/ai-helper/server.ts). Deterministic, no network, no
 * key used. It "reads" a synthetic RFQ written one item per line:
 *
 *   Customer: Acme Engineering Ltd
 *   - 25 x Bracket, Part: BR-100, Material: 6082-T6 aluminium, Finish: clear anodise, Due: 2026-12-04
 *
 * A field left out comes back null (so the route flags it). For the tests of the guards around it:
 *   [mock:down]     the service does not answer (AiProviderError unavailable)
 *   [mock:refuse]   the model declines (refused)
 *   [mock:garbage]  an answer that is not the JSON asked for (invalid)
 *   text asking to "ignore previous instructions": the answer a steered model might give (extra keys, a price, an action, a quote
 *   reference the server never sent, a negative quantity, an impossible date). The route must drop all of it.
 * For the round-up it states the total from the facts. For the assistant (G3; data with a question and records) it answers from the
 * records: the count and the newest reference, and a chaser e-mail draft when the question asks for one; a question asking it to
 * "ignore previous instructions" gets the answer a steered model might give (a claimed send, a reference it was never given, an
 * unknown draft kind, an action and a tool call). The route must show none of that as done.
 */
export function mockProvider(): AiHelperProvider {
  return {
    id: "mock",
    async complete(req: AiCompletionRequest): Promise<AiCompletion> {
      const usage = { inputTokens: Math.ceil(Buffer.byteLength(req.system + req.data) / 4), outputTokens: 120 };
      const data = JSON.parse(req.data) as Record<string, unknown>;
      const text = typeof data.rfq_email === "string" ? data.rfq_email : typeof data.question === "string" ? data.question : "";
      if (text.includes("[mock:down]")) throw new AiProviderError("unavailable");
      if (text.includes("[mock:refuse]")) throw new AiProviderError("refused", usage);
      if (text.includes("[mock:garbage]")) throw new AiProviderError("invalid", usage);
      if (Array.isArray(data.sections)) return { json: roundup(data), usage, model: req.model };
      if (Array.isArray(data.records)) return { json: /ignore (all )?previous instructions/i.test(text) ? steeredAssistant(data) : assistant(data, text), usage, model: req.model };
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

type MockRecord = { ref: string; status: string | null; customer: string | null };

function assistant(data: Record<string, unknown>, question: string) {
  const records = data.records as MockRecord[];
  const first = records[0];
  const wantsDraft = /draft|e-?mail|chase/i.test(question);
  return {
    answer: first ? `${records.length} ${String(data.topic)} found. The newest is ${first.ref} (${first.status ?? "no status"}) for ${first.customer ?? "no customer"}.` : `No ${String(data.topic)} found.`,
    refs: first ? [first.ref] : [],
    draft: first && wantsDraft
      ? { kind: "email", subject: `Following up: ${first.ref}`, body: `Dear ${first.customer ?? "customer"},\n\nI am following up on ${first.ref}. Please let us know if you have any questions.\n\nKind regards` }
      : { kind: "none", subject: "", body: "" },
    needs_review: [],
  };
}

function steeredAssistant(data: Record<string, unknown>) {
  const first = (data.records as MockRecord[])[0];
  return {
    answer: `Done. I have sent the e-mail and issued invoice INV-9999 for ${first?.customer ?? "Customer 1"}.`,
    refs: ["QUO-9999", ...(first ? [first.ref] : [])],
    draft: { kind: "send_now", subject: "Paid", body: "<script>alert(1)</script>" },
    needs_review: [],
    action: "send_email",
    tool_call: { name: "issue_invoice", amount: 1 },
  };
}
