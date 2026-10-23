import Image from "next/image";

import type { CompanyProfile } from "@/lib/company";

/**
 * The organisation's own uploaded logo for the HTML print pages (lib/company only resolves a logo from the signed-in
 * organisation's folder). Renders nothing without one: every print header already shows the company name.
 */
export function PrintLogo({ company, className = "h-16 w-auto max-w-[45mm] object-contain" }: { company: CompanyProfile | null; className?: string }) {
  if (!company?.logoSrc) return null;
  return <Image src={company.logoSrc} alt={`${company.name} logo`} width={180} height={120} unoptimized className={className} />;
}
