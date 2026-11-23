/**
 * Module K (worksheet builder): the company's brand colour on a custom worksheet. Pure.
 *
 * Inputs: CompanyProfile.brandPrimary (#rrggbb, or "" for none). Outputs: an ink colour for headings and rules that is always readable on
 * white paper. A missing or invalid colour gives black; a colour too light to read (relative luminance above 0.55) also gives black.
 * Must not change: only a valid 6-digit hex is ever used as a colour, so nothing from storage can inject CSS.
 */
export const DEFAULT_INK = "#000000";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** WCAG relative luminance of #rrggbb (0 black .. 1 white). */
export function luminance(hex: string): number {
  const channel = (start: number) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function brandInk(brandPrimary: string | null | undefined): string {
  const value = (brandPrimary ?? "").trim();
  if (!HEX.test(value) || luminance(value) > 0.55) return DEFAULT_INK;
  return value.toLowerCase();
}
