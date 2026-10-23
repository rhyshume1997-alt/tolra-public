import "server-only";
import { ImageResponse } from "next/og";

const SIZES = new Set([32, 48, 180, 192, 512]);

// The Tolra app icon (512 x 512 source). Full-bleed square: no rounded corners, padding or border of its own, because
// phones apply their own mask. The mark sits inside the maskable safe zone (the middle 80% circle), so the same art
// is also the maskable icon. Company logos are not used here: they stay inside the app and on documents.
export const TOLRA_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0b1626"/><circle cx="256" cy="256" r="150" fill="none" stroke="#4f7cff" stroke-width="30"/><path d="M178 196h156v44h-56v112h-44V240h-56z" fill="#fff"/></svg>';

const SRC = `data:image/svg+xml;base64,${Buffer.from(TOLRA_ICON_SVG).toString("base64")}`;

/** The installed-app icon / favicon PNG at ?size= (32, 48, 180, 192 or 512; anything else is 192). The same for everyone. */
export function appIconResponse(request: Request, requestedSize?: number) {
  const askedSize = requestedSize ?? Number(new URL(request.url).searchParams.get("size"));
  const size = SIZES.has(askedSize) ? askedSize : 192;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={SRC} width={size} height={size} style={{ width: size, height: size }} />
      </div>
    ),
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
