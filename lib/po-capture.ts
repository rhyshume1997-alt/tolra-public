/**
 * Customer PO and supplier e-mails from the inbox (migration 125). Plain text matching only: no AI, no attachment contents (file names
 * are used when given; the inbox check does not store any yet). Pure: no database, no network.
 *
 * SUGGEST ONLY (ChatGPT's conditions, 1 Nov). Nothing here links anything. A suggestion needs BOTH:
 *   - the sender: their address, or their company's own e-mail domain (never a shared mail domain such as gmail.com), is one we hold
 *     for the quote's customer or the order's supplier; and
 *   - a PO number in the e-mail (subject, body or an attachment file name).
 * A PO number alone, or the sender alone, is never a suggestion. A person chooses from the suggestions and clicks Link.
 * AUTO_LINK_ENABLED stays false: automatic linking is reserved for a later, separately approved change (the database refuses it too).
 */

export const AUTO_LINK_ENABLED = false;
/** The database keeps at most this many suggestions per e-mail (125's CHECK). */
export const MAX_SUGGESTIONS = 10;
const MAX_TEXT = 20_000;

export type InboundForMatch = { fromAddress: string | null; subject: string | null; bodyText: string | null; attachmentNames?: readonly string[] };
export type QuoteCandidate = { id: string; ref: string; status: string | null; customer: string; customerPo: string | null; customerEmails: readonly string[] };
export type PurchaseOrderCandidate = { id: string; ref: string; status: string | null; supplier: string; supplierEmails: readonly string[] };
export type PoNumber = { value: string; normalised: string; snippet: string; source: "subject" | "body" | "attachment" };
export type PoSuggestion = { kind: "quote" | "purchase_order"; id: string; ref: string; po: string; snippet: string; reason: string };
export type MatchResult = { poNumbers: PoNumber[]; suggestions: PoSuggestion[] };

/** Shared mail services: the same domain there says nothing about who the sender is. */
const SHARED_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com", "yahoo.com", "yahoo.co.uk",
  "icloud.com", "me.com", "mac.com", "aol.com", "aol.co.uk", "btinternet.com", "btopenworld.com", "sky.com", "talktalk.net", "virginmedia.com",
  "ntlworld.com", "blueyonder.co.uk", "protonmail.com", "proton.me", "gmx.com", "gmx.co.uk", "mail.com", "zoho.com", "yandex.com", "tiscali.co.uk",
]);

/** For comparison only: upper case, no spaces, hyphens, underscores, dots or slashes, and no leading "PO" before a digit. */
export function normalisePo(value: string): string {
  return value.toUpperCase().replace(/[\s_./\\-]/g, "").replace(/^PO(?=\d)/, "");
}

/** Our own document numbers (quote, invoice, delivery note, sales order, job, credit note) are never a customer's PO. */
const OWN_DOC_REF = /^(?:QUO|INV|DLN|DN|SO|CN|J)-?\d+$/i;
const QUOTE_REF = /\bQUO-?\s?\d{2,}\b/gi;

/** A PO number is announced by one of these. "order" alone ("order 500 brackets") and "ref" alone are not enough. */
const KEYWORD = /\b(?:p\.?\s?o(?:\b|(?=\d))\.?|purchase\s+order|order\s*(?:no\b\.?|number|num\b\.?|ref(?:erence)?\b|#)|(?:your|our)\s+(?:order|ref(?:erence)?)\b|ref(?:erence)?\s*(?:no\b\.?|number)?\s*[:#])/gi;
/** Filler between the keyword and the number: "PO number: 4471", "P.O. No. 4471", "Purchase order # 4471". */
const FILLER = /^(?:[\s:#.\-]*(?:no\b\.?|number|num\b\.?|nr\b\.?|ref(?:erence)?\b|is\b|was\b))*[\s:#.]*/i;
const TOKEN = /^[A-Z0-9][A-Z0-9/-]{0,29}/i;

function digits(value: string) {
  return value.replace(/\D/g, "");
}

/** Dates, phone numbers, VAT numbers, our own document numbers and too-short tokens are not PO numbers. */
export function plausiblePo(token: string): boolean {
  const t = token.replace(/[-/]+$/, "");
  const n = normalisePo(t);
  if (n.length < 3 || digits(n).length < 2) return false;
  if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(t)) return false; // 12/05/2026, 2026-05-12
  if (/^(?:0|44)\d{9,12}$/.test(digits(t)) && /^[\d\s+()-]+$/.test(t)) return false; // 01698000003, 447700900123
  if (/^GB\d{9}(?:\d{3})?$/i.test(n)) return false; // GB123456789
  if (OWN_DOC_REF.test(t)) return false;
  return true;
}

function snippetAt(text: string, start: number, end: number) {
  const from = Math.max(0, start - 50);
  const to = Math.min(text.length, end + 50);
  const piece = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${piece}${to < text.length ? "…" : ""}`.slice(0, 200);
}

/** Every PO number announced in one piece of text, in order, once each (by normalised value). */
function extractFrom(text: string, source: PoNumber["source"]): PoNumber[] {
  const out: PoNumber[] = [];
  for (const m of text.matchAll(KEYWORD)) {
    const at = m.index ?? 0;
    const keyword = m[0];
    const rest = text.slice(at + keyword.length);
    // "PO Box 12" and a Portsmouth postcode ("PO12 3AB") are addresses.
    if (/^p\.?\s?o\b/i.test(keyword) && /^[\s.]*box\b/i.test(rest)) continue;
    if (/^PO$/i.test(keyword) && /^\d{1,2}\s+\d[A-Z]{2}\b/i.test(rest)) continue;
    const glued = /^p\.?o$/i.test(keyword) && /^-?\d/.test(rest); // PO4471, PO-0007
    const filler = glued ? (rest.match(/^-?/)?.[0] ?? "") : (rest.match(FILLER)?.[0] ?? "");
    const token = rest.slice(filler.length).match(TOKEN)?.[0]?.replace(/[-/]+$/, "");
    if (!token || !plausiblePo(token)) continue;
    const value = glued ? `${keyword.toUpperCase().replace(/\./g, "")}${filler}${token}` : token;
    const end = at + keyword.length + filler.length + token.length;
    out.push({ value, normalised: normalisePo(value), snippet: snippetAt(text, at, end), source });
  }
  return out;
}

/** The PO numbers in an e-mail: subject first, then body, then attachment file names. */
export function extractPoNumbers(email: InboundForMatch): PoNumber[] {
  const seen = new Set<string>();
  const out: PoNumber[] = [];
  const sources: Array<[string, PoNumber["source"]]> = [
    [email.subject ?? "", "subject"],
    [(email.bodyText ?? "").slice(0, MAX_TEXT), "body"],
    ...(email.attachmentNames ?? []).map((name): [string, PoNumber["source"]] => [name.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_]+/g, " "), "attachment"]),
  ];
  for (const [text, source] of sources) {
    for (const po of extractFrom(text, source)) {
      if (seen.has(po.normalised)) continue;
      seen.add(po.normalised);
      out.push(po);
    }
  }
  return out;
}

/** Our quote numbers named in the e-mail (normalised, e.g. QUO0012). */
export function quoteRefsIn(email: InboundForMatch): Set<string> {
  const text = `${email.subject ?? ""}\n${(email.bodyText ?? "").slice(0, MAX_TEXT)}\n${(email.attachmentNames ?? []).join("\n")}`;
  return new Set([...text.matchAll(QUOTE_REF)].map((m) => m[0].toUpperCase().replace(/[\s-]/g, "")));
}

function cleanAddress(value: string): string {
  const inner = value.match(/<([^>]+)>/)?.[1] ?? value;
  return inner.trim().toLowerCase();
}

/** Splits a stored e-mail field that may hold several addresses ("a@x.com; b@x.com"). */
export function emailList(value: string | null | undefined): string[] {
  return (value ?? "").split(/[;,\s]+/).map(cleanAddress).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
}

/** How the sender is one of the known addresses: the same address, or the same company domain (not a shared mail service). */
export function senderMatches(sender: string | null | undefined, known: readonly string[]): "address" | "domain" | null {
  const from = cleanAddress(sender ?? "");
  const domain = from.split("@")[1];
  if (!domain) return null;
  const list = known.flatMap((k) => emailList(k));
  if (list.includes(from)) return "address";
  if (!SHARED_MAIL_DOMAINS.has(domain) && list.some((k) => k.split("@")[1] === domain)) return "domain";
  return null;
}

const OPEN_QUOTE = new Set(["sent", "accepted"]);

/**
 * The suggestions for one e-mail. Customer side: the sender is the quote's customer AND the e-mail has a PO number, and either the PO
 * equals the quote's customer PO (123), or the quote has none yet and the e-mail names the quote's number, or (weakest) it is one of
 * that customer's sent quotes with no PO. Supplier side: the sender is the order's supplier AND the order's number is in the e-mail.
 * Strongest first, at most MAX_SUGGESTIONS.
 */
export function matchInboundEmail(
  email: InboundForMatch,
  data: { quotes: readonly QuoteCandidate[]; purchaseOrders: readonly PurchaseOrderCandidate[] },
): MatchResult {
  const poNumbers = extractPoNumbers(email);
  if (!poNumbers.length) return { poNumbers, suggestions: [] };
  const named = quoteRefsIn(email);
  const ranked: Array<PoSuggestion & { rank: number }> = [];

  for (const quote of data.quotes) {
    if (!OPEN_QUOTE.has(String(quote.status ?? "draft"))) continue;
    const who = senderMatches(email.fromAddress, quote.customerEmails);
    if (!who) continue;
    const own = quote.customerPo?.trim() ? normalisePo(quote.customerPo) : null;
    const isNamed = named.has(quote.ref.toUpperCase().replace(/[\s-]/g, "")) || named.has(quote.ref.toUpperCase().replace(/[\s-]/g, "").replace(/-?V\d+$/, ""));
    for (const po of poNumbers) {
      if (normalisePo(po.value) === normalisePo(quote.ref)) continue;
      if (own) {
        if (po.normalised === own) ranked.push({ kind: "quote", id: quote.id, ref: quote.ref, po: po.value, snippet: po.snippet, reason: `PO ${po.value} is ${quote.ref}'s customer PO, from the customer`, rank: who === "address" ? 0 : 1 });
      } else if (isNamed) {
        ranked.push({ kind: "quote", id: quote.id, ref: quote.ref, po: po.value, snippet: po.snippet, reason: `From the customer, names ${quote.ref}, PO ${po.value}`, rank: who === "address" ? 2 : 3 });
      } else if (quote.status === "sent") {
        ranked.push({ kind: "quote", id: quote.id, ref: quote.ref, po: po.value, snippet: po.snippet, reason: `From the customer, PO ${po.value}; the quote is not named`, rank: who === "address" ? 4 : 5 });
      }
    }
  }

  for (const order of data.purchaseOrders) {
    if (String(order.status ?? "") === "draft" || !order.ref.trim()) continue;
    const who = senderMatches(email.fromAddress, order.supplierEmails);
    if (!who) continue;
    const ref = normalisePo(order.ref);
    const po = poNumbers.find((p) => p.normalised === ref);
    if (po) ranked.push({ kind: "purchase_order", id: order.id, ref: order.ref, po: po.value, snippet: po.snippet, reason: `From the supplier, about ${order.ref}`, rank: who === "address" ? 0 : 1 });
  }

  ranked.sort((a, b) => a.rank - b.rank);
  const seen = new Set<string>();
  const suggestions: PoSuggestion[] = [];
  for (const r of ranked) {
    const s: PoSuggestion = { kind: r.kind, id: r.id, ref: r.ref, po: r.po, snippet: r.snippet, reason: r.reason };
    const key = `${s.kind}:${s.id}:${normalisePo(s.po)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(s);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return { poNumbers, suggestions };
}
