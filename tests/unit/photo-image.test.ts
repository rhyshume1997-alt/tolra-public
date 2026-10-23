/**
 * Job photos prepared on the device (lib/photo-image.ts, migration 040): the EXIF orientation is read and applied, the longest
 * edge comes down to 2048 px (never up), the JPEG is stepped down in quality until it is 2 MiB or less, and every metadata
 * segment (EXIF with its GPS position and camera make, the encoder's own ICC profile) is gone from the bytes. The byte-level
 * helpers run on real JPEG bytes; the pipeline runs here with a fake encoder and in the browser spec with the real one.
 */
import { describe, expect, it } from "vitest";

import {
  PHOTO_MAX_BYTES, PHOTO_MAX_EDGE, PHOTO_QUALITIES, type CanvasOp, type EncodeRequest, type PhotoPorts,
  exifOrientation, exifOrientationSegment, fitWithin, jpegInfo, jpegSegments, orientationDraw, orientedSize, preparePhoto, probeJpeg, stripMetadata, withSegment,
} from "@/lib/photo-image";

import { EXIF_MAKE, JPEG_4x2, JPEG_64x32, carriesTestExif, exifApp1, taggedJpeg } from "../support/exif";

const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("JPEG bytes", () => {
  it("reads the size of real JPEGs and sees no metadata in the clean fixtures", () => {
    expect(jpegInfo(bytes(JPEG_4x2))).toEqual({ width: 4, height: 2, orientation: null, metadataSegments: [] });
    expect(jpegInfo(bytes(JPEG_64x32))).toEqual({ width: 64, height: 32, orientation: null, metadataSegments: [] });
    expect(jpegSegments(bytes(JPEG_4x2)).map((s) => s.marker.toString(16))).toEqual(["e0", "db", "db", "c0", "c4", "c4", "c4", "c4", "da"]);
    expect(() => jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow("Not a JPEG file.");
    expect(() => jpegSegments(bytes(JPEG_4x2).subarray(0, 40))).toThrow("Not a JPEG file.");
  });

  it("reads the EXIF orientation, the camera make and the GPS position that a tagged photo carries", () => {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const tagged = taggedJpeg(bytes(JPEG_64x32), { orientation, gps: true });
      expect(exifOrientation(tagged)).toBe(orientation);
      expect(jpegInfo(tagged)).toMatchObject({ width: 64, height: 32, orientation, metadataSegments: [0xe1] });
    }
    const tagged = taggedJpeg(bytes(JPEG_4x2), { orientation: 6 });
    expect(text(tagged)).toContain(EXIF_MAKE);
    expect(text(tagged)).toContain("Exif\0\0");
    // The GPS IFD pointer tag (0x8825) is in the TIFF, little-endian.
    expect(text(tagged)).toContain("\x25\x88");
    expect(carriesTestExif(tagged)).toBe(true);
    expect(carriesTestExif(bytes(JPEG_4x2))).toBe(false);
    // Big-endian TIFF and an unknown value are handled too.
    const be = exifApp1({ orientation: 8, gps: false });
    expect(exifOrientation(withSegment(bytes(JPEG_4x2), be))).toBe(8);
    expect(exifOrientation(withSegment(bytes(JPEG_4x2), exifOrientationSegment(9)))).toBeNull();
    expect(exifOrientation(withSegment(bytes(JPEG_4x2), exifOrientationSegment(0)))).toBeNull();
  });

  it("stripMetadata removes EXIF (orientation, make, GPS), XMP-style APP1, ICC (APP2) and comments and leaves the picture bytes as they were", () => {
    const icc = new Uint8Array([0xff, 0xe2, 0, 8, 0x49, 0x43, 0x43, 0x5f, 0x50, 0x52]); // APP2 "ICC_PR"
    const comment = new Uint8Array([0xff, 0xfe, 0, 7, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // COM "hello"
    const dirty = withSegment(withSegment(taggedJpeg(bytes(JPEG_64x32), { orientation: 6, gps: true }), icc), comment);
    expect(jpegInfo(dirty).metadataSegments.sort()).toEqual([0xe1, 0xe2, 0xfe]);
    const clean = stripMetadata(dirty);
    expect(Buffer.from(clean).equals(JPEG_64x32)).toBe(true);
    expect(jpegInfo(clean)).toEqual({ width: 64, height: 32, orientation: null, metadataSegments: [] });
    expect(carriesTestExif(clean)).toBe(false);
    expect(text(clean)).not.toContain("hello");
    expect(text(clean)).not.toContain("ICC_PR");
  });

  it("the orientation probe is a 4x2 JPEG turned by 180 degrees", () => {
    const probe = probeJpeg();
    expect(jpegInfo(probe)).toEqual({ width: 4, height: 2, orientation: 3, metadataSegments: [0xe1] });
    expect(Buffer.from(stripMetadata(probe)).equals(JPEG_4x2)).toBe(true);
  });
});

describe("geometry", () => {
  it("fits inside 2048 on the longest edge and never enlarges", () => {
    expect(fitWithin(4000, 3000, PHOTO_MAX_EDGE)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, PHOTO_MAX_EDGE)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(640, 480, PHOTO_MAX_EDGE)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(2048, 2048, PHOTO_MAX_EDGE)).toEqual({ width: 2048, height: 2048 });
    expect(fitWithin(10000, 1, PHOTO_MAX_EDGE)).toEqual({ width: 2048, height: 1 });
  });

  it("orientations 5 to 8 swap the axes and each orientation has its canvas transform", () => {
    expect(orientedSize(300, 200, 6)).toEqual({ width: 200, height: 300 });
    expect(orientedSize(300, 200, 3)).toEqual({ width: 300, height: 200 });
    const half = Math.PI / 2;
    const plans: Record<number, { width: number; height: number; ops: CanvasOp[] }> = {
      1: { width: 300, height: 200, ops: [] },
      2: { width: 300, height: 200, ops: [["translate", 300, 0], ["scale", -1, 1]] },
      3: { width: 300, height: 200, ops: [["translate", 300, 200], ["rotate", Math.PI]] },
      4: { width: 300, height: 200, ops: [["translate", 0, 200], ["scale", 1, -1]] },
      5: { width: 200, height: 300, ops: [["rotate", half], ["scale", 1, -1]] },
      6: { width: 200, height: 300, ops: [["translate", 200, 0], ["rotate", half]] },
      7: { width: 200, height: 300, ops: [["rotate", half], ["translate", 300, -200], ["scale", -1, 1]] },
      8: { width: 200, height: 300, ops: [["translate", 0, 300], ["rotate", -half]] },
    };
    for (const [orientation, plan] of Object.entries(plans)) expect(orientationDraw(Number(orientation), 300, 200)).toEqual(plan);
  });
});

/**
 * A fake browser: the decoder answers with a given size (and whether it applied the orientation); the encoder records each
 * request and returns a synthetic JPEG of the requested size whose byte count follows quality (w * h * quality * factor), with
 * an ICC segment the way Chromium's canvas encoder adds one.
 */
function fakePorts(decoded: { width: number; height: number; orientationApplied: boolean }, factor = 0.9, dims?: (r: EncodeRequest) => { width: number; height: number }) {
  const requests: EncodeRequest[] = [];
  let closed = 0;
  const ports: PhotoPorts = {
    decode: async () => ({ ...decoded, image: { fake: true }, close: () => { closed += 1; } }),
    encode: async (request) => {
      requests.push(request);
      const { width, height } = dims ? dims(request) : request;
      // Anything over the cap is simply "too big": no need to allocate gigabytes to say so.
      const payload = Math.min(PHOTO_MAX_BYTES + 1, Math.max(0, Math.round(width * height * request.quality * factor)));
      const head = [0xff, 0xd8, 0xff, 0xe2, 0, 6, 0x49, 0x43, 0x43, 0x5f, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0, 0xff, 0xda, 0, 2];
      const out = new Uint8Array(head.length + payload + 2);
      out.set(head, 0);
      out.set([0xff, 0xd9], head.length + payload);
      return new Blob([out], { type: "image/jpeg" });
    },
  };
  return { ports, requests, closed: () => closed };
}

describe("preparePhoto", () => {
  it("brings a 4000x3000 photo down to 2048x1536, steps the quality down until it is 2 MiB or less, and returns clean bytes", async () => {
    const fake = fakePorts({ width: 4000, height: 3000, orientationApplied: true });
    const result = await preparePhoto(new Blob([JPEG_64x32]), fake.ports);
    expect(result).toMatchObject({ width: 2048, height: 1536, quality: 0.7, maxEdge: PHOTO_MAX_EDGE });
    expect(result.bytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    expect(result.blob.size).toBe(result.bytes);
    expect(result.blob.type).toBe("image/jpeg");
    // 0.85 and 0.78 were over the cap, 0.7 fits: three encodes, every one at the planned size with no transform.
    expect(fake.requests.map((r) => r.quality)).toEqual([0.85, 0.78, 0.7]);
    expect(fake.requests.every((r) => r.width === 2048 && r.height === 1536 && r.drawWidth === 2048 && r.drawHeight === 1536 && r.ops.length === 0)).toBe(true);
    const out = new Uint8Array(await result.blob.arrayBuffer());
    expect(jpegInfo(out)).toEqual({ width: 2048, height: 1536, orientation: null, metadataSegments: [] }); // the encoder's ICC segment is gone
    expect(fake.closed()).toBe(1);
  });

  it("applies EXIF orientation 6 itself when the decoder didn't (the picture comes out 1536x2048, drawn through the rotation)", async () => {
    const fake = fakePorts({ width: 4000, height: 3000, orientationApplied: false });
    const tagged = taggedJpeg(bytes(JPEG_64x32), { orientation: 6, gps: true });
    const result = await preparePhoto(new Blob([tagged]), fake.ports);
    expect(result).toMatchObject({ width: 1536, height: 2048 });
    const last = fake.requests.at(-1)!;
    expect(last).toMatchObject({ drawWidth: 2048, drawHeight: 1536, width: 1536, height: 2048, ops: [["translate", 1536, 0], ["rotate", Math.PI / 2]] });
    const out = new Uint8Array(await result.blob.arrayBuffer());
    expect(jpegInfo(out)).toEqual({ width: 1536, height: 2048, orientation: null, metadataSegments: [] });
    expect(carriesTestExif(out)).toBe(false);
  });

  it("leaves the orientation alone when the decoder already applied it (the decoded size is the turned one)", async () => {
    const fake = fakePorts({ width: 3000, height: 4000, orientationApplied: true });
    const tagged = taggedJpeg(bytes(JPEG_64x32), { orientation: 6 });
    const result = await preparePhoto(new Blob([tagged]), fake.ports);
    expect(result).toMatchObject({ width: 1536, height: 2048 });
    expect(fake.requests.at(-1)).toMatchObject({ drawWidth: 1536, drawHeight: 2048, width: 1536, height: 2048, ops: [] });
  });

  it("never enlarges a small photo, and a PNG (no EXIF) goes through unturned", async () => {
    const fake = fakePorts({ width: 640, height: 480, orientationApplied: false });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const result = await preparePhoto(new Blob([png]), fake.ports);
    expect(result).toMatchObject({ width: 640, height: 480, quality: PHOTO_QUALITIES[0] });
    expect(fake.requests).toHaveLength(1);
  });

  it("when no quality fits, the edge is reduced step by step; a photo that can't be made small enough is refused", async () => {
    // factor 2.2: 2048x1536 at 0.4 is 2.77 MB (no quality fits at 2048); at the next edge, 1638x1229, 0.54 is 2.39 MB and 0.46 is
    // 2.04 MB (2,037,259 bytes, under 2 MiB): fits at the second edge, sixth quality.
    const stepped = fakePorts({ width: 4000, height: 3000, orientationApplied: true }, 2.2);
    const result = await preparePhoto(new Blob([JPEG_64x32]), stepped.ports);
    expect(result).toMatchObject({ width: 1638, height: 1229, quality: 0.46, maxEdge: 1638 });
    expect(result.bytes).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    expect(stepped.requests).toHaveLength(PHOTO_QUALITIES.length + 6);
    expect(stepped.requests.map((r) => r.width)).toEqual([...Array<number>(7).fill(2048), ...Array<number>(6).fill(1638)]);
    // Nothing ever fits: every quality at every edge down to the floor is tried, then it is refused.
    const hopeless = fakePorts({ width: 4000, height: 3000, orientationApplied: true }, 1000);
    await expect(preparePhoto(new Blob([JPEG_64x32]), hopeless.ports)).rejects.toThrow("can't be made small enough");
    expect(Math.min(...hopeless.requests.map((r) => Math.max(r.width, r.height)))).toBe(640);
    expect(hopeless.closed()).toBe(1);
  });

  it("refuses an encoder result that isn't the planned picture", async () => {
    const wrong = fakePorts({ width: 1000, height: 800, orientationApplied: true }, 0.1, () => ({ width: 999, height: 800 }));
    await expect(preparePhoto(new Blob([JPEG_64x32]), wrong.ports)).rejects.toThrow("couldn't be prepared");
  });
});
