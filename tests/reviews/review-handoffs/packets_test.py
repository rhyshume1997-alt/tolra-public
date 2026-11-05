import hashlib, json, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[3]
PACK=ROOT/'docs/agent-control/review-handoffs'
class Packets(unittest.TestCase):
 def test_inventory_and_requested_recent_prs(self):
  rows=json.loads((PACK/'index.json').read_text());ns=[r['number'] for r in rows]
  self.assertEqual(len(ns),len(set(ns)));self.assertGreaterEqual(len(ns),175)
  for n in range(385,398):self.assertIn(n,ns)
  self.assertEqual(len(list(PACK.glob('PR-*.md'))),len(ns))
 def test_required_fields_and_hashes(self):
  for r in json.loads((PACK/'index.json').read_text()):
   text=(PACK/r['packet']).read_text()
   for field in ['AWAITING CHATGPT REVIEW','Objective:','Acceptance criteria:','Repository:','Branch / observed SHA:','PR URL / GitHub state:','Files changed:','Migrations / verification / rollback:','Test results','CI run URL','Known limits:','Outstanding approvals:']:
    self.assertIn(field,text,str(r['number']))
   self.assertEqual(hashlib.sha256((PACK/r['evidence']).read_bytes()).hexdigest(),r['evidence_sha256'])
 def test_ci_is_bound_to_observed_head(self):
  for path in (PACK/'evidence').glob('PR-*.json'):
   r=json.loads(path.read_text());self.assertRegex(r['observed_head'],r'^[a-f0-9]{40}$')
   for run in r['workflow_runs']:
    self.assertEqual(run['head_sha'],r['observed_head']);self.assertTrue(run['url'].startswith('https://github.com/rhyshume1997-alt/tolra-public/actions/runs/'))
 def test_all_paths_and_migrations_are_recorded_without_execution_claim(self):
  for path in (PACK/'evidence').glob('PR-*.json'):
   r=json.loads(path.read_text());self.assertTrue(r['branch'].startswith('codex/'))
   self.assertEqual(r['review_status'],'AWAITING CHATGPT REVIEW')
   for f in r['migration_verification_rollback_paths']:self.assertIn(f,r['files'])
if __name__=='__main__':unittest.main()
