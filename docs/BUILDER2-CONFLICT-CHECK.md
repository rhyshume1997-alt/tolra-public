# Builder 2 branch conflict check

Checked 3 November 2026 against main a546c3a9b37ad53d3ab235b1c545b577b84db9f5.

All 22 open builder 2 PRs (#111–115 and #132–148) were checked against their own base and main: 34 comparisons. Four branches (#135, #139, #140, #145) conflicted with main in supabase/verify/release_preflight.sql. Each now contains an actual merge commit with main as a parent. No PR was merged.

The resolution keeps account security markers 136 and 137 from main and costing marker 143 from the costing branch, in that order. The catalogue snapshot merged automatically. The conflict resolution kept the existing application behaviour and no SQL was run. All 34 comparisons are now clean.

CI recorded before these merges is historical for #135, #139 and #140; check their new exact heads again. Other #132–143 heads were unchanged. Database preflight execution remains Claude Code’s task.

Final check: all 25 open builder 2 PRs through #151 were checked against their current base and main: 38 comparisons, all clean. Updated stacked bases were also merged into #139/#140/#145 so their ancestry and diffs are clear. Latest-head web jobs for #135/#139/#140/#145 all passed; links and SHAs are in BUILDER2-CI-WEB.md.
