"use client";

import Link from "next/link";
import { AiMasterCard } from "@/components/ai-helper/master-card";
import { useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";

/** Reuses the company's AI switches; Integrations does not store a second on/off value. */
export function AiConnectionCard() {
  const { status, loaded, allowed, setStatus } = useAiHelperStatus();
  return <section className="space-y-3" aria-label="AI integration">
    {!loaded ? <p role="status">Loading AI connection…</p>
      : !allowed ? <p>AI is unavailable. Ask your admin to contact Tolra support.</p>
      : !status ? <p role="alert">Could not load this company&apos;s AI settings. Reload to try again.</p>
      : <AiMasterCard status={status} onStatus={setStatus} />}
    <Link href="/ai-helper" className="inline-flex min-h-11 items-center text-sm underline">AI settings, key and monthly limit</Link>
  </section>;
}
