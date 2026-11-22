import "server-only";
import { ImageResponse } from "next/og";

import type { Image } from "@/lib/server/branding";
import { textOn } from "@/lib/branding";

/**
 * BOUNDARY (module 13, Company look). Inputs: a company's brand colour and logo (its own PNG/JPEG only). Output: a square PNG.
 * The logo sits on a white plate on the brand colour, so any logo stays readable. The "maskable" art keeps the plate inside the
 * safe circle (phones crop to a circle). Must not change: only this company's own logo is ever drawn (loadLogo checks the folder).
 */

export function companyIconResponse(opts: { primary: string; logo: Image; size: number; maskable: boolean; headers: Record<string, string> }) {
  const { primary, logo, size, maskable } = opts;
  const plate = Math.round(size * (maskable ? 0.56 : 0.72));
  const pad = Math.round(plate * 0.1);
  const src = `data:${logo.type};base64,${logo.bytes.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: primary, color: textOn(primary) }}>
        <div style={{ width: plate, height: plate, display: "flex", alignItems: "center", justifyContent: "center", background: "#ffffff", borderRadius: Math.round(plate * 0.16) }}>
          {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
          <img src={src} width={plate - pad * 2} height={plate - pad * 2} style={{ width: plate - pad * 2, height: plate - pad * 2, objectFit: "contain" }} />
        </div>
      </div>
    ),
    { width: size, height: size, headers: opts.headers },
  );
}
