import type { ReactNode } from "react";

import { marketingFontVariables } from "@/components/marketing/fonts";
import "@/components/marketing/marketing.css";

/** The drawing sheet every public page sits on: the marketing faces, the paper and its 10 mm grid. */
export function MarketingSheet({ children }: { children: ReactNode }) {
  return <div className={`${marketingFontVariables} mk-sheet flex flex-col`}>{children}</div>;
}
