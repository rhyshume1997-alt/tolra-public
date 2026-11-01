import { NextResponse } from "next/server";

import { GraphError, isGraphLink, listInboxSince, MAX_PAGES } from "@/lib/m365/graph";
import { graphFailure, mailGuard } from "@/lib/m365/route";
import { isErrorResponse, jsonError } from "@/lib/server/auth";

/** With nothing stored yet, the first check looks back this far (24 hours). */
const FIRST_LOOKBACK_MS = 24 * 3600_000;

/**
 * Picks up new inbox messages (GET only: the mailbox is not changed or marked read). A message is stored once,
 * whatever the number of polls (record_inbound_email, migration 031), and each new one becomes an RFQ.
 * Returns { read, inserted, duplicates, more }; more = true when the page limit stopped the check. The place it stopped
 * (Microsoft's paging link) is kept per company (mail_poll_state), so the next check carries on from there, however many
 * messages share one time.
 */
export async function POST(request: Request) {
  const ctx = await mailGuard(request);
  if (isErrorResponse(ctx)) return ctx;
  const { supabase, profile } = ctx.auth;
  const saveState = (nextLink: string | null, checkpoint: string | null) => supabase.rpc("save_mail_poll_state", { p_next_link: nextLink, p_checkpoint: checkpoint });

  const { data: state, error: stateError } = await supabase.from("mail_poll_state").select("next_link, checkpoint").eq("organization_id", profile.organization_id).maybeSingle();
  const { data: latest, error: latestError } = await supabase
    .from("inbound_emails")
    .select("received_at")
    .eq("organization_id", profile.organization_id)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (stateError || latestError) {
    console.error("[mail/poll] lookup failed", (stateError ?? latestError)?.code);
    return jsonError("Could not check the inbox", 500);
  }
  const since: string = state?.checkpoint ?? latest?.received_at ?? new Date(Date.now() - FIRST_LOOKBACK_MS).toISOString();

  // A stored link that isn't a Microsoft Graph link is thrown away, never followed.
  let resume: string | null = state?.next_link ?? null;
  if (resume && !isGraphLink(resume)) {
    console.error("[mail/poll] stored paging link discarded");
    resume = null;
    await saveState(null, null);
  }

  // Everything from the checkpoint (or the stored paging link) on, page after page; messages already stored are skipped by
  // the database.
  let result;
  try {
    try {
      result = await listInboxSince(since, ctx.config.pageSize, ctx.config, MAX_PAGES, resume);
    } catch (err) {
      // A paging link Microsoft no longer accepts: forget it and start the check again from the checkpoint.
      if (!resume || !(err instanceof GraphError) || err.outcome !== "failed" || err.status === 429) throw err;
      console.error("[mail/poll] stored paging link refused, starting again");
      await saveState(null, null);
      result = await listInboxSince(since, ctx.config.pageSize, ctx.config);
    }
  } catch (err) {
    return graphFailure("mail/poll", err);
  }
  const { messages, more, nextLink } = result;

  let inserted = 0;
  let duplicates = 0;
  for (const m of messages) {
    const { data, error } = await supabase.rpc("record_inbound_email", {
      p_graph_message_id: m.id,
      p_internet_message_id: m.internetMessageId,
      p_from_address: m.from,
      p_from_name: m.fromName,
      p_subject: m.subject,
      p_received_at: m.receivedAt,
      p_body_preview: m.bodyPreview,
      p_body_text: m.bodyText,
    });
    if (error) {
      console.error("[mail/poll] store failed", error.code);
      return NextResponse.json({ error: "Could not store some messages", read: messages.length, inserted, duplicates, more }, { status: 500 });
    }
    if ((data as { inserted?: boolean } | null)?.inserted) inserted += 1;
    else duplicates += 1;
  }

  // Stopped at the page limit: keep the link to carry on from. Reached the end: clear it and move the checkpoint on to the
  // newest message seen. Saved after the messages are stored, so a failure here only means reading some of them again.
  const newest = messages.length ? messages[messages.length - 1].receivedAt : null;
  const { error: saveError } = await saveState(more ? nextLink : null, newest);
  if (saveError) console.error("[mail/poll] state not saved", saveError.code);
  return NextResponse.json({ read: messages.length, inserted, duplicates, more });
}
