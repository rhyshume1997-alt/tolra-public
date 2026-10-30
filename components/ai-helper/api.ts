import type { AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";

export const pounds = (pence: number) => (pence / 100).toFixed(2);

/** One call to an AI section route as the signed-in person; the answer is the company's new status. Throws the route's own message. */
export async function sendAiHelper(path: string, init: RequestInit): Promise<AiHelperStatus> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const payload = (await response.json().catch(() => ({}))) as AiHelperStatus & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Could not save.");
  return payload;
}
