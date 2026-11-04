# Builder 4 handover: AU

4 November 2026. Explicit Rhys assignment continues the previously budget-blocked AU job. Atomic claim claims/AU. Read root AGENTS.md plus #257 handover and #271 ownership. CM/CN/CO/CP/CQ untouched. No Next guide directory exists at node_modules/next/dist/docs in this installed Next 15 checkout; edits are literal displayed strings only, with no framework API change.

Reviewed all 30 PRs #232–#261: compared app/components/lib against each PR merge base at these heads; inspected added/changed screen text and user-facing server errors, deduplicating inherited changes. Most later PRs add only tests/docs/SQL, so they add no separate shop-screen wording. Marketing fonts #242 change no text. The issue report lists only confusing wording and its fix.

| PR | Reviewed full head |
| --- | --- |
| #232 | `d5c69bd4f06c1518ccac6af965fb2df29d21cfab` |
| #233 | `97811d301479d4e409b8eb89f0e7ff2bc61db7e6` |
| #234 | `baafb39e1ff33d11d3c5023cd764c8fcfb8f182e` |
| #235 | `46c8249328cb82d3520ed4373d1cbe711f18bc3d` |
| #236 | `d54d90b0408fbd490f03ada687b27af03bba9800` |
| #237 | `86eda4bd48b1237b42140dbd72ace7cb73442f4b` |
| #238 | `ad17969b9453163e8c46a57e32114f2b84395522` |
| #239 | `1226c15f168ae4c77b27412e96d8d2cb06763da5` |
| #240 | `3692debaa9a724762f230412eff17aa911a85ba2` |
| #241 | `f96087a58bf7dd9030e447e71a10b52ba54671d9` |
| #242 | `25b792572c7a5df0e141fdbc91cdd54afa46daa8` |
| #243 | `15020e5d20afe27cb48847c310ccf39ff1c99da8` |
| #244 | `537b3ea4ede00702bb853aadb492e013af38a797` |
| #245 | `2b4bd18390efc468a01b449dae70c844ee204a05` |
| #246 | `d5ab1c7edbb72e33cd032f9a65860a95e4229160` |
| #247 | `41c685c416305637d86b580324fff9e6cda037ff` |
| #248 | `a38ffd683c370788fa1c3d98a324081c08d37950` |
| #249 | `f2ca4650e4032800c11d5ab65fb85e39ae0f22fd` |
| #250 | `7fb1656f5a990239a95109c44565b48f1ece1107` |
| #251 | `b8e9b3daeb9f6b07d144c57d4a453c39bf731176` |
| #252 | `5a923801befe5ffd1514ba19938ff9090685a436` |
| #253 | `dd2f7a176cce318aea4b6f725e5c029480f9848b` |
| #254 | `8d4616f3a61f7acde8646eb3a63224997a120728` |
| #255 | `57061b0e67f3fc77ce5c13a0472a3a72bafaa9b1` |
| #256 | `d41d122fbf9f3aa9818b886e65e33b765397693a` |
| #257 | `f0a654c5ed894b14884cad4dcedc6cb3a171bccf` |
| #258 | `349195f498338c352bead29eb6e0afd76b4f53a9` |
| #259 | `2c9ded37e503d66cf9b96c620e98fdd86abf1302` |
| #260 | `3c151ae1b58d05697f9272aa3216d4ee6ffdf087` |
| #261 | `14e7291070a99ee10658da2781699859310124c7` |

Checks: affected accounting/chase/AI suites 64 passed, 0 failed/skipped; editor/AI integration suites 26 passed, 0 failed/skipped. Updated the existing AI integration wording assertion to the exact new text, retaining its refusal-state coverage. `npm run typecheck` and explicit changed-code ESLint passed (exit 0, no errors); `git diff --check` passed. The first editor run exposed that stale wording assertion (1 failed / 25 passed); it was corrected and all 26 passed. An initially supplied nonexistent editor filename selected no editor tests; the two exact editor files were then run explicitly. No new tests for literal text edits; existing affected regressions retained. No change to SQL, data, user roles, monetary rules or email evidence handling. No main merge, deployment, live email or production SQL.

Next: independent reviewer reads the issue table and changed strings. Carry this one draft into the final integrated branch, then perform the already-required browser/operator rehearsal.
