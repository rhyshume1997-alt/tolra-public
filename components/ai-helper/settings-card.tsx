"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";

import { useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Settings > AI: a pointer only. The AI switches, the monthly limit and the company's own Anthropic key moved to the AI section
 * (/ai-helper), which is the one place for them. Shown to admins only when this server has the AI helper on (AI_HELPER_ENABLED).
 */
export function AiHelperSettingsCard() {
  const { status, allowed } = useAiHelperStatus();
  if (!allowed || !status?.can_manage) return null;
  return (
    <Card data-testid="ai-helper-settings-link">
      <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="size-5 text-brand-accent" /> AI</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-slate-500">The AI on/off switch, the monthly limit and your company&apos;s own Anthropic key are in the AI section.</p>
        <Button asChild variant="outline" size="sm" className="min-h-9"><Link href="/ai-helper">Open the AI section</Link></Button>
      </CardContent>
    </Card>
  );
}
