"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";

import { anyFeatureOn, useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { Button } from "@/components/ui/button";

/** The way into the AI helper: shown only when this server has it on, the person is office or admin, and the company has a feature on. */
export function AiHelperDashboardLink() {
  const { status } = useAiHelperStatus();
  if (!anyFeatureOn(status)) return null;
  return (
    <Button asChild variant="outline" size="sm" className="min-h-9">
      <Link href="/ai-helper"><Sparkles className="size-4" /> AI helper</Link>
    </Button>
  );
}
