/**
 * EXIF for test fixtures: an APP1 segment with an orientation, a camera make and a GPS position, so a test can prove the photo
 * pipeline drops all of it. Little-endian TIFF, IFD0 (Make, Orientation, GPS pointer) and a GPS IFD (lat/long refs and
 * rationals). Pure bytes, no library.
 */
import { withSegment } from "@/lib/photo-image";

export const EXIF_MAKE = "TestCam";
/** 51 deg 30' 26" N, 0 deg 7' 39" W (a well-known public landmark, not a person's location). */
export const EXIF_GPS = { lat: [51, 30, 26], latRef: "N", lon: [0, 7, 39], lonRef: "W" } as const;

export function exifApp1({ orientation = 1, gps = true }: { orientation?: number; gps?: boolean } = {}): Uint8Array {
  const make = `${EXIF_MAKE}\0`;
  const ifd0Entries = gps ? 3 : 2;
  const ifd0 = 8;
  const makeAt = ifd0 + 2 + ifd0Entries * 12 + 4;
  const gpsIfd = makeAt + make.length;
  const gpsEntries = 4;
  const latAt = gpsIfd + 2 + gpsEntries * 12 + 4;
  const lonAt = latAt + 24;
  const tiffLength = gps ? lonAt + 24 : makeAt + make.length;
  const tiff = new Uint8Array(tiffLength);
  const view = new DataView(tiff.buffer);
  const u16 = (at: number, v: number) => view.setUint16(at, v, true);
  const u32 = (at: number, v: number) => view.setUint32(at, v, true);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => { u16(at, tag); u16(at + 2, type); u32(at + 4, count); u32(at + 8, value); };
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i += 1) tiff[at + i] = text.charCodeAt(i); };
  // TIFF header.
  ascii(0, "II"); u16(2, 42); u32(4, ifd0);
  // IFD0.
  u16(ifd0, ifd0Entries);
  entry(ifd0 + 2, 0x010f, 2, make.length, makeAt);
  entry(ifd0 + 14, 0x0112, 3, 1, orientation);
  if (gps) entry(ifd0 + 26, 0x8825, 4, 1, gpsIfd);
  u32(ifd0 + 2 + ifd0Entries * 12, 0);
  ascii(makeAt, make);
  if (gps) {
    u16(gpsIfd, gpsEntries);
    // Refs are 2-byte ASCII, stored inline in the value field ("N\0").
    entry(gpsIfd + 2, 0x0001, 2, 2, EXIF_GPS.latRef.charCodeAt(0));
    entry(gpsIfd + 14, 0x0002, 5, 3, latAt);
    entry(gpsIfd + 26, 0x0003, 2, 2, EXIF_GPS.lonRef.charCodeAt(0));
    entry(gpsIfd + 38, 0x0004, 5, 3, lonAt);
    u32(gpsIfd + 2 + gpsEntries * 12, 0);
    EXIF_GPS.lat.forEach((v, i) => { u32(latAt + i * 8, v); u32(latAt + i * 8 + 4, 1); });
    EXIF_GPS.lon.forEach((v, i) => { u32(lonAt + i * 8, v); u32(lonAt + i * 8 + 4, 1); });
  }
  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  payload.set(tiff, 6);
  const length = payload.length + 2;
  const out = new Uint8Array(4 + payload.length);
  out.set([0xff, 0xe1, length >> 8, length & 0xff], 0);
  out.set(payload, 4);
  return out;
}

/** A JPEG with the given EXIF (orientation, camera make, GPS) inserted after SOI. */
export const taggedJpeg = (jpeg: Uint8Array, options?: Parameters<typeof exifApp1>[0]) => withSegment(jpeg, exifApp1(options));

/** True when the bytes still carry any sign of the EXIF this helper writes (the make or the GPS tag). */
export function carriesTestExif(bytes: Uint8Array): boolean {
  const text = Array.from(bytes.subarray(0, Math.min(bytes.length, 4096)), (b) => String.fromCharCode(b)).join("");
  return text.includes(EXIF_MAKE) || text.includes("Exif\0\0");
}

// ----- fixtures made once with Chromium's canvas encoder (tests/fixtures: scratch script), ICC profile stripped ----------
/** 4 x 2 px, left half black, right half white. 297 bytes. */
export const JPEG_4x2 = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAACAAQDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABkQAAEFAAAAAAAAAAAAAAAAAAgACjmIuP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwB+muMFAM2Z2GQSD//Z", "base64");
/** 64 x 32 px, left half blue, right half red. 345 bytes. */
export const JPEG_64x32 = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAAgAEADAREAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAkK/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABcBAQEBAQAAAAAAAAAAAAAAAAALCAr/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwDHO7+GVwAAFeEq9SgAAASHVUE18AABXhKvUoAAAEh1VBNfAAAV4Sr1KAAABIdVQTXwAAFeEq9SgAAAf//Z", "base64");
