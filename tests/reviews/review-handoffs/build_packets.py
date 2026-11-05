"""Build handoffs from already-fetched PUBLIC metadata; never dispatches CI or reads company data."""
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
DEST = ROOT / 'docs/agent-control/review-handoffs'

def build(cache):
    records = []
    for path in sorted(pathlib.Path(cache).glob('*.json'), key=lambda p: int(p.stem)):
        r = json.loads(path.read_text()); p = r['pr']
        if not p['head']['ref'].startswith('codex/'):
            continue
        body = p.get('body') or ''
        files = r['files']; runs = r['workflow_runs']
        n = p['number']; sha = p['head']['sha']
        migrations = [f for f in files if f.startswith(('supabase/migrations/','supabase/release/','supabase/verify/','supabase/cutover/'))]
        claims = [line.strip() for line in body.splitlines() if re.search(r'\b(test|tests|passed|failed|skipped|vitest|lint|typecheck|TypeScript|NOT EXECUTED)\b', line, re.I)]
        state = 'merged' if p.get('merged_at') else p['state'] + ' (not merged)'
        evidence = {
            'number': n, 'url': p['html_url'], 'title': p['title'], 'branch': p['head']['ref'],
            'observed_head': sha, 'base_sha': p['base']['sha'], 'github_state': state,
            'merged_at': p.get('merged_at'), 'observed_at': r['observed_at'],
            'files': files, 'migration_verification_rollback_paths': migrations,
            'public_pr_body': body, 'historical_test_claims': claims,
            'workflow_runs': runs, 'review_status': 'AWAITING CHATGPT REVIEW',
        }
        evidence_path = DEST / 'evidence' / f'PR-{n}.json'
        evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
        body_excerpt = re.sub(r'\s+', ' ', body.split('\n\n')[0] if body else 'No public acceptance description supplied.')
        body_excerpt = body_excerpt[:650] + ('… (full frozen description in evidence)' if len(body_excerpt)>650 else '')
        def clean(t): return str(t).replace('\n',' ').replace('|','/').replace('<','&lt;').replace('>','&gt;')
        file_summary = ', '.join('`'+f+'`' for f in files[:6]) + (f'; {len(files)} total, complete list in evidence' if len(files)>6 else '')
        ci = '; '.join(f"[{v['id']}]({v['url']}) {v['status']}/{v['conclusion'] or 'not concluded'}" for v in runs[:3]) if runs else 'NOT OBSERVED: public query returned no run for this exact head'
        test_claim = clean(' '.join(claims))[:1400] if claims else 'NOT DOCUMENTED in public PR description; passed/failed/skipped unproven'
        text = f'''# PR #{n}: {clean(p['title'])}

**AWAITING CHATGPT REVIEW**

- Objective: {clean(p['title'])}.
- Acceptance criteria: check the exact diff against the frozen PR description: “{clean(body_excerpt)}”. Retain its guards and refusal cases; a test or blank form is not operational acceptance. Missing criteria need the original owner, not invented approval.
- Repository: rhyshume1997-alt/tolra-public.
- Branch / observed SHA: `{p['head']['ref']}` / `{sha}`.
- PR URL / GitHub state: [#{n}]({p['html_url']}) / {state}. Observed {r['observed_at']}.
- Files changed: {file_summary or 'NONE in observed file API'}; [complete evidence](evidence/PR-{n}.json).
- Migrations / verification / rollback: {', '.join('`'+f+'`' for f in migrations) if migrations else 'NONE in observed diff paths'}. Presence is not execution; inspect the listed SQL and its associated verification/rollback before approval.
- Test results (historical PR-author claims, NOT re-run for this packet): {test_claim}. Complete exact claims and original description in evidence; absent counts remain NOT DOCUMENTED, never assumed zero.
- CI run URL / status at observed SHA: {ci}. Full observed run list in evidence; required-job/integration completion is unproven unless separately checked.
- Known limits: source/diff/test claims do not prove production deployment, installed migrations, real-data results or company acceptance. The full PR description's limits remain in force; compare any changed head. No private evidence accessed.
- Outstanding approvals: **ChatGPT review** of exact current diff; original owner answers for any missing criteria/evidence; Rhys for release/production/configuration/activation where applicable. No packet grants merge or live authority.
'''
        (DEST / f'PR-{n}.md').write_text(text)
        records.append({'number':n,'branch':p['head']['ref'],'observed_head':sha,'state':state,'packet':f'PR-{n}.md','evidence':f'evidence/PR-{n}.json','evidence_sha256':hashlib.sha256(evidence_path.read_bytes()).hexdigest(),'review_status':'AWAITING CHATGPT REVIEW'})
    (DEST/'index.json').write_text(json.dumps(records,indent=2)+'\n')
    lines=['# Public Codex review handoffs','',f'{len(records)} public Codex-prefixed PRs; every packet is **AWAITING CHATGPT REVIEW**. No reviews were requested through GitHub and no messages sent.','',
    'Coverage uses all public `codex/` PR branches as a conservative superset because builders share the GitHub account. This does not assign another builder\'s work to this agent. Existing ownership, historical review and GitHub merge state remain intact. Includes closed/merged historical PRs and #385–#392; no closed PR is reopened. No private repo or file is an input.','',
    'Each packet freezes exact public changed-file paths, head, PR description/test claims and existing Actions run metadata. Original test logs stay with their PR; generating a packet does not re-run tests or establish missing counts. Read the frozen JSON when the short excerpt is insufficient. CI run metadata is observed, not guaranteed current or a proof that every required job passed.','',
    'New docs/test-evidence PRs may classify as code under .github/workflows/ci.yml. Observed #394/#395: web success, integration skipped, ci-gate failure. The existing gate requires full integration after the ready label for code-classified changes; no label, bypass or dispatch was added. Exact gate logs could not be downloaded (runner log endpoint refused access); cause attribution uses public job/step metadata and workflow source, not a claimed log quote.','',
    'Review packets are evidence summaries, not a master plan. No release, production SQL, merge, real data or activation is authorised. DONE coded/merged does not prove deployed or verified in production. Blank approvals stay blank.','',
    '| PR | Packet | GitHub state | Review |','| --- | --- | --- | --- |']
    for r in reversed(records):lines.append(f"| #{r['number']} | [{r['packet']}]({r['packet']}) | {r['state']} | AWAITING CHATGPT REVIEW |")
    (DEST/'README.md').write_text('\n'.join(lines)+'\n')
    print('Built',len(records),'public packets')

if __name__ == '__main__':
    build(sys.argv[1])
