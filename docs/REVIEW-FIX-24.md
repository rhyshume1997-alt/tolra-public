# Chase review fix (job 24)

This PR follows #144 and must be integrated with #132/#134. Settings save in one save_chase_steps_atomic RPC, carrying the displayed company and expected snapshot. The proposal now takes p_org; Claude must review/package it before enabling this client. No SQL was applied.

Approval accepts only saved reviewed subject and body. Inline edits in the send request are rejected. Save an edit, then review it again. One conditional database UPDATE claims the matching company, draft status, recipient and text as sending. A changed draft or second approval cannot claim it. Editors require drafted status and check a row changed. The provider receives captured reviewed text without normalisation.

An unknown send result leaves the source claimed: check provider/history rather than automatically sending or editing again. A mailer that only created a draft releases the claim; a recorded send removes the claimed source. No approval token survives an edit.

Checks: 21 approval and 13 wiring cases reported passing, including edits during provider preflight, edits after claim, double approval and one atomic settings RPC. TypeScript and targeted ESLint passed. Local Vitest needs timeout cleanup after results; remote CI is separate. No live DB/provider tests run.
