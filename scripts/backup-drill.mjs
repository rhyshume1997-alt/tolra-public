// Synthetic data for scripts/backup-restore-drill.sh (audit L4). Never used against a hosted project.
//   node scripts/backup-drill.mjs seed   <source url> <source service key> <state file>
//   node scripts/backup-drill.mjs verify <target url> <target anon key> <target service key> <state file>
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { createClient } from "@supabase/supabase-js";

const [mode, ...args] = process.argv.slice(2);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const loopback = (url) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`Refusing: ${url} is not a local stack`);
  return url;
};
const client = (url, key) => createClient(loopback(url), key, { auth: { persistSession: false, autoRefreshToken: false } });

/** A one-page PDF that says `text` (hand-built, correct xref offsets). */
function pdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A small PNG (w x h, one colour). */
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x5a)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (mode === "seed") {
  const [url, serviceKey, stateFile] = args;
  const admin = client(url, serviceKey);
  const tag = randomUUID().slice(0, 8);
  const folder = randomUUID();
  const user = { email: `restore.drill.${tag}@example.test`, password: `Drill-${randomUUID()}` };
  const { error: userError } = await admin.auth.admin.createUser({ ...user, email_confirm: true });
  if (userError) throw userError;
  const files = [
    { bucket: "job-drawings", name: `${folder}/drill-job/DRAWING ${tag}.pdf`, type: "application/pdf", bytes: pdf(`SYNTHETIC DRAWING ${tag}`), text: `SYNTHETIC DRAWING ${tag}` },
    { bucket: "quote-attachments", name: `${folder}/QUO-DRILL/spec-${tag}.png`, type: "image/png", bytes: png(37, 23) },
  ];
  for (const file of files) {
    const { error } = await admin.storage.from(file.bucket).upload(file.name, file.bytes, { contentType: file.type });
    if (error) throw error;
  }
  writeFileSync(stateFile, JSON.stringify({ user, files: files.map(({ bytes, ...f }) => ({ ...f, sha256: sha(bytes), size: bytes.length })) }));
  console.log(`[seed] user ${user.email}; ${files.map((f) => `${f.bucket}/${f.name}`).join(", ")}`);
} else if (mode === "verify") {
  const [url, anonKey, serviceKey, stateFile] = args;
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const admin = client(url, serviceKey);
  const dir = mkdtempSync(path.join(tmpdir(), "drill-open-"));
  for (const file of state.files) {
    const { data, error } = await admin.storage.from(file.bucket).download(file.name);
    if (error) throw new Error(`${file.bucket}/${file.name} missing on the restored project: ${error.message}`);
    const bytes = Buffer.from(await data.arrayBuffer());
    if (sha(bytes) !== file.sha256) throw new Error(`${file.bucket}/${file.name} differs from the original`);
    const local = path.join(dir, path.basename(file.name));
    writeFileSync(local, bytes);
    if (file.type === "application/pdf") {
      // Opened with a real PDF reader: its text must be the drawing's.
      const text = execFileSync("pdftotext", [local, "-"], { encoding: "utf8" });
      if (!text.includes(file.text)) throw new Error(`restored drawing opens but doesn't read "${file.text}"`);
      console.log(`[open] ${file.bucket}/${file.name}: PDF opens, reads "${file.text}", identical (${bytes.length} bytes)`);
    } else {
      if (bytes.subarray(1, 4).toString() !== "PNG") throw new Error("restored attachment is not a PNG");
      console.log(`[open] ${file.bucket}/${file.name}: PNG ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}, identical (${bytes.length} bytes)`);
    }
  }
  const { data: signedIn, error: signInError } = await client(url, anonKey).auth.signInWithPassword(state.user);
  if (signInError || !signedIn.session) throw new Error(`restored user can't sign in: ${signInError?.message}`);
  console.log(`[sign-in] ${state.user.email} signs in on the restored project`);
} else {
  throw new Error("usage: backup-drill.mjs seed|verify ...");
}
