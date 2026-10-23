/**
 * Job photos made on the device before they leave it (migration 040). A photo taken or chosen on a phone is re-encoded here:
 *   - the EXIF orientation is applied, so the stored picture is the right way up everywhere;
 *   - the longest edge is brought down to 2048 px (never enlarged);
 *   - it is written as a JPEG of at most 2 MiB, stepping the quality down until it fits;
 *   - every piece of metadata goes: the canvas re-encode carries no EXIF (so no location, no device, no time), and every
 *     APPn / COM segment the encoder itself adds (Chromium writes an ICC profile) is stripped from the bytes as well. The
 *     result is checked before it is returned: a JPEG of the planned size with no metadata segments at all.
 *
 * The browser work (decode, canvas, encode) is behind `PhotoPorts`, so the pipeline is tested with a fake encoder in
 * Node and with the real browser in the end-to-end spec. The byte-level helpers (segments, orientation, dimensions, strip)
 * are pure and tested on real JPEG bytes.
 */

export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_MIME = "image/jpeg";
/** Quality steps tried at each size, highest first. */
export const PHOTO_QUALITIES = [0.85, 0.78, 0.7, 0.62, 0.54, 0.46, 0.4] as const;
/** When no quality fits, the longest edge is reduced by this factor; below the floor the photo is refused. */
const EDGE_STEP = 0.8;
const EDGE_FLOOR = 640;

// ----- JPEG bytes -----------------------------------------------------------------------------------------------
export type JpegSegment = { marker: number; offset: number; length: number };

/** The segments from SOI up to and including SOS (the entropy-coded data after it is not scanned). Throws on non-JPEG bytes. */
export function jpegSegments(bytes: Uint8Array): JpegSegment[] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG file.");
  const out: JpegSegment[] = [];
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error("Not a JPEG file.");
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push({ marker, offset: i, length: 0 }); // standalone markers
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) throw new Error("Not a JPEG file.");
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) throw new Error("Not a JPEG file.");
    out.push({ marker, offset: i, length });
    if (marker === 0xda) break; // SOS
    i += 2 + length;
  }
  return out;
}

const isMetadataMarker = (marker: number) => (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe; // APP1..APP15, COM
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** The EXIF orientation (1 to 8) from the APP1 Exif segment, or null when there is none. */
export function exifOrientation(bytes: Uint8Array): number | null {
  for (const seg of jpegSegments(bytes)) {
    if (seg.marker !== 0xe1) continue;
    const p = seg.offset + 4;
    if (seg.length < 16 || String.fromCharCode(...bytes.subarray(p, p + 4)) !== "Exif" || bytes[p + 4] !== 0 || bytes[p + 5] !== 0) continue;
    const tiff = p + 6;
    const end = seg.offset + 2 + seg.length;
    const order = String.fromCharCode(bytes[tiff], bytes[tiff + 1]);
    if (order !== "II" && order !== "MM") continue;
    const little = order === "II";
    const u16 = (at: number) => (at + 2 <= end ? (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]) : NaN);
    const u32 = (at: number) => (at + 4 <= end ? (little ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000 : bytes[at] * 0x1000000 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])) : NaN);
    if (u16(tiff + 2) !== 42) continue;
    const ifd = tiff + u32(tiff + 4);
    const count = u16(ifd);
    if (!Number.isFinite(count)) continue;
    for (let n = 0; n < count; n += 1) {
      const entry = ifd + 2 + n * 12;
      if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  }
  return null;
}

export type JpegInfo = { width: number; height: number; orientation: number | null; metadataSegments: number[] };

/** Width and height as encoded (before any orientation), the EXIF orientation and the metadata segments (APPn/COM markers) present. */
export function jpegInfo(bytes: Uint8Array): JpegInfo {
  const segments = jpegSegments(bytes);
  const sof = segments.find((s) => isSof(s.marker));
  if (!sof) throw new Error("Not a JPEG file.");
  const p = sof.offset + 5;
  return {
    height: (bytes[p] << 8) | bytes[p + 1],
    width: (bytes[p + 2] << 8) | bytes[p + 3],
    orientation: exifOrientation(bytes),
    metadataSegments: segments.filter((s) => isMetadataMarker(s.marker)).map((s) => s.marker),
  };
}

/** The same JPEG without any APP1..APP15 or COM segment (EXIF, XMP, ICC, comments). APP0 (JFIF) and the image data are kept. */
export function stripMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const segments = jpegSegments(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let total = 2;
  for (const seg of segments) {
    if (isMetadataMarker(seg.marker)) continue;
    const slice = seg.marker === 0xda ? bytes.subarray(seg.offset) : bytes.subarray(seg.offset, seg.offset + 2 + seg.length);
    parts.push(slice);
    total += slice.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The smallest APP1 Exif segment that says "orientation = n" (little-endian TIFF, one IFD0 entry). */
export function exifOrientationSegment(orientation: number): Uint8Array {
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...payload]);
}

/** `jpeg` with `segment` inserted right after SOI (test fixtures and the orientation probe). */
export function withSegment(jpeg: Uint8Array, segment: Uint8Array): Uint8Array<ArrayBuffer> {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Not a JPEG file.");
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

// ----- geometry -------------------------------------------------------------------------------------------------
/** Width and height after an orientation (5 to 8 swap the axes). */
export function orientedSize(width: number, height: number, orientation: number) {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/** The size that fits inside `maxEdge` on its longest edge, never enlarged, at least 1 px. */
export function fitWithin(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type CanvasOp = ["translate", number, number] | ["rotate", number] | ["scale", number, number];
export type DrawPlan = { width: number; height: number; ops: CanvasOp[] };

/**
 * How to draw an image of `dw` x `dh` (already scaled) so that EXIF orientation `orientation` comes out upright: the canvas size
 * and the transforms to apply before drawImage(image, 0, 0, dw, dh).
 */
export function orientationDraw(orientation: number, dw: number, dh: number): DrawPlan {
  const half = Math.PI / 2;
  switch (orientation) {
    case 2: return { width: dw, height: dh, ops: [["translate", dw, 0], ["scale", -1, 1]] };
    case 3: return { width: dw, height: dh, ops: [["translate", dw, dh], ["rotate", Math.PI]] };
    case 4: return { width: dw, height: dh, ops: [["translate", 0, dh], ["scale", 1, -1]] };
    case 5: return { width: dh, height: dw, ops: [["rotate", half], ["scale", 1, -1]] };
    case 6: return { width: dh, height: dw, ops: [["translate", dh, 0], ["rotate", half]] };
    case 7: return { width: dh, height: dw, ops: [["rotate", half], ["translate", dw, -dh], ["scale", -1, 1]] };
    case 8: return { width: dh, height: dw, ops: [["translate", 0, dw], ["rotate", -half]] };
    default: return { width: dw, height: dh, ops: [] };
  }
}

// ----- the pipeline ---------------------------------------------------------------------------------------------
export type DecodedImage = {
  /** The decoded size: already turned when the decoder applied the EXIF orientation itself. */
  width: number;
  height: number;
  /** True when the decoder applied the EXIF orientation (the picture is upright as decoded). */
  orientationApplied: boolean;
  image: unknown;
  close?: () => void;
};
export type EncodeRequest = { image: unknown; drawWidth: number; drawHeight: number; width: number; height: number; ops: CanvasOp[]; quality: number };
export type PhotoPorts = {
  decode: (blob: Blob) => Promise<DecodedImage>;
  encode: (request: EncodeRequest) => Promise<Blob>;
};

export type PreparedPhoto = { blob: Blob; width: number; height: number; bytes: number; quality: number; maxEdge: number };

/**
 * The photo as it will be stored. Throws when the file can't be read as an image or can't be made small enough.
 * The result is verified before it is returned: a JPEG of the planned size, EXIF orientation 1 (none), no metadata segments.
 */
export async function preparePhoto(file: Blob, ports: PhotoPorts = browserPorts()): Promise<PreparedPhoto> {
  let orientation = 1;
  try {
    orientation = exifOrientation(new Uint8Array(await file.arrayBuffer())) ?? 1;
  } catch {
    orientation = 1; // not a JPEG (PNG, WebP): nothing to turn
  }
  const decoded = await ports.decode(file);
  try {
    const manual = orientation !== 1 && !decoded.orientationApplied;
    let maxEdge = PHOTO_MAX_EDGE;
    for (;;) {
      const { width: dw, height: dh } = fitWithin(decoded.width, decoded.height, maxEdge);
      const plan = manual ? orientationDraw(orientation, dw, dh) : { width: dw, height: dh, ops: [] as CanvasOp[] };
      for (const quality of PHOTO_QUALITIES) {
        const encoded = await ports.encode({ image: decoded.image, drawWidth: dw, drawHeight: dh, width: plan.width, height: plan.height, ops: plan.ops, quality });
        const clean = stripMetadata(new Uint8Array(await encoded.arrayBuffer()));
        if (clean.length > PHOTO_MAX_BYTES) continue;
        const info = jpegInfo(clean);
        if (info.width !== plan.width || info.height !== plan.height || info.orientation !== null || info.metadataSegments.length) {
          throw new Error("The photo couldn't be prepared on this device.");
        }
        return { blob: new Blob([clean], { type: PHOTO_MIME }), width: info.width, height: info.height, bytes: clean.length, quality, maxEdge };
      }
      if (maxEdge <= EDGE_FLOOR) throw new Error("This photo can't be made small enough to upload. Try a plainer shot.");
      maxEdge = Math.max(EDGE_FLOOR, Math.floor(maxEdge * EDGE_STEP));
    }
  } finally {
    decoded.close?.();
  }
}

// ----- browser ports --------------------------------------------------------------------------------------------
/** A 4x2 JPEG, left half black and right half white, with EXIF orientation 3 (turn 180): decoded upright, its left pixel is white. */
const PROBE_BASE = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAACAAQDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABkQAAEFAAAAAAAAAAAAAAAAAAgACjmIuP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwB+muMFAM2Z2GQSD//Z";
export function probeJpeg(): Uint8Array<ArrayBuffer> {
  const raw = atob(PROBE_BASE);
  const base = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) base[i] = raw.charCodeAt(i);
  return withSegment(base, exifOrientationSegment(3));
}

let orientationProbe: Promise<boolean> | null = null;
/**
 * Does this browser's createImageBitmap apply the EXIF orientation by itself? Decided once, by decoding the probe and reading
 * its first pixel. Neither answer loses anything: when it doesn't, the pipeline turns the picture itself.
 */
export function decoderAppliesOrientation(): Promise<boolean> {
  orientationProbe ??= (async () => {
    try {
      const bitmap = await createImageBitmap(new Blob([probeJpeg()], { type: PHOTO_MIME }));
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, 1, 1).data[0] > 128;
    } catch {
      return false;
    }
  })();
  return orientationProbe;
}

/** The real browser: ImageBitmap decode and a 2D canvas JPEG encode. */
export function browserPorts(): PhotoPorts {
  return {
    async decode(blob) {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        throw new Error("This file couldn't be read as a photo. Use a JPEG, PNG or WebP image.");
      }
      return { width: bitmap.width, height: bitmap.height, orientationApplied: await decoderAppliesOrientation(), image: bitmap, close: () => bitmap.close() };
    },
    async encode({ image, drawWidth, drawHeight, width, height, ops, quality }) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This device can't prepare photos (no canvas).");
      for (const op of ops) {
        if (op[0] === "translate") ctx.translate(op[1], op[2]);
        else if (op[0] === "rotate") ctx.rotate(op[1]);
        else ctx.scale(op[1], op[2]);
      }
      ctx.drawImage(image as CanvasImageSource, 0, 0, drawWidth, drawHeight);
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The photo couldn't be encoded on this device."))), PHOTO_MIME, quality);
      });
    },
  };
}
