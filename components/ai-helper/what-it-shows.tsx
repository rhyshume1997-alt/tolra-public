import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** "What this shows": the three AI features in plain words, for anyone who can open the AI section. Static text. */
export function AiWhatItShows() {
  return (
    <Card data-testid="ai-what-it-shows">
      <CardHeader><CardTitle>What this shows</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        <p>The AI only suggests. A person checks and approves everything. It never sends, issues, approves, voids, records payments or edits your records.</p>
        <ul className="space-y-3">
          <li><span className="font-medium text-slate-900">Round-up.</span> A daily or weekly summary of work that is late, waiting or unbilled, in plain words. It is read-only: it uses the same figures as your dashboard and changes nothing.</li>
          <li><span className="font-medium text-slate-900">RFQ e-mail to draft quote.</span> Paste a customer&apos;s RFQ e-mail and it prepares a draft quote. Prices come only from your fixed calculation, never from the AI, and anything it is unsure of is marked <span className="font-medium">Needs human review</span>. Nothing is saved until you approve it, and then only as a draft.</li>
          <li><span className="font-medium text-slate-900">Finance check.</span> Before you issue an invoice, purchase order or credit note, it lists suggestions on the draft (for example totals that do not add up, or a possible duplicate). You can accept or dismiss each one, and you can always issue without waiting for it.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
