// Derives the site icons from public/brand/tolra-icon-flat.png (no new artwork): node scripts/make-brand-icons.mjs
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const SRC = "public/brand/tolra-icon-flat.png";
const NAVY = { r: 11, g: 42, b: 91, alpha: 1 };
const png = (size) => sharp(SRC).resize(size, size, { kernel: "lanczos3" }).png({ compressionLevel: 9, palette: true, effort: 10 }).toBuffer();

for (const [file, size] of [["icon-32.png", 32], ["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
  writeFileSync(`public/icons/${file}`, await png(size));
}

// Maskable: the mark is scaled to 80% so its corners sit inside the 80% safe circle, on the same navy.
const inner = await sharp(SRC).resize(410, 410, { kernel: "lanczos3" }).png().toBuffer();
writeFileSync("public/icons/icon-maskable-512.png", await sharp({ create: { width: 512, height: 512, channels: 4, background: NAVY } })
  .composite([{ input: inner, gravity: "centre" }]).png({ compressionLevel: 9, palette: true, effort: 10 }).toBuffer());

// favicon.ico: 16, 32 and 48 px PNG images in an ICO container (sharp does not write .ico).
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((s) => sharp(SRC).resize(s, s, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer()));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const at = 6 + 16 * i;
  head.writeUInt8(s, at); head.writeUInt8(s, at + 1); head.writeUInt8(0, at + 2); head.writeUInt8(0, at + 3);
  head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6);
  head.writeUInt32LE(images[i].length, at + 8); head.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
writeFileSync("public/icons/favicon.ico", Buffer.concat([head, ...images]));

// Compressed copies for the site (originals stay in public/brand): the share image (still exactly 1200x630) and the hero logo.
await sharp("public/brand/tolra-og.png").png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toFile("public/marketing/tolra-og.png");
await sharp("public/brand/tolra-icon-full.png").resize(640, 640, { kernel: "lanczos3" }).png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toFile("public/marketing/tolra-logo.png");
