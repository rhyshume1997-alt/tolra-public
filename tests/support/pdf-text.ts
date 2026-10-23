/**
 * Text drawn on a generated PDF (react-pdf / pdfkit output with the standard Helvetica fonts): inflates every content
 * stream and joins the hex strings of each TJ/Tj text operator. Good enough to assert which amounts a document prints.
 */
import { inflateSync } from "node:zlib";

export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const out: string[] = [];
  // pdfkit ends a stream with "\nendstream" (never "\r\n"): a compressed stream whose last byte happens to be 0x0D must keep it.
  const streamRe = /stream\r?\n([\s\S]*?)\nendstream/g;
  for (const match of raw.matchAll(streamRe)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue; // images, fonts and other non-text streams
    }
    for (const op of body.matchAll(/\[(.*?)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
      const chunk = op[1] ?? `<${op[2]}>`;
      const text = [...chunk.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join("");
      if (text) out.push(text);
    }
  }
  return out.join("\n");
}
