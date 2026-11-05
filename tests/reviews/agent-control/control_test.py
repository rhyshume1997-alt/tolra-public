import pathlib, subprocess, unittest, json
ROOT=pathlib.Path(__file__).resolve().parents[3]
class Control(unittest.TestCase):
 def test_original_guidance_retained(self):
  for name in ['AGENTS.md','CLAUDE.md']:
   old=subprocess.check_output(['git','show',f'68f89ca:{name}'],cwd=ROOT,text=True)
   new=(ROOT/name).read_text();self.assertTrue(new.endswith(old));self.assertTrue(new.startswith('Read [current-state]'))
 def test_decisions_and_gates(self):
  d=(ROOT/'docs/agent-control/decisions.md').read_text()
  for value in ['1000p','12 November 2026','9 November 2026','138, 140, 141, 144, 145, 146, 147','Production stays OFF','John approves']:
   self.assertIn(value,d)
 def test_each_task_has_required_columns(self):
  t=(ROOT/'docs/agent-control/task-board.md').read_text()
  for value in ['Task ID','Objective','Agent','Files','Acceptance criteria','Tests','Branch or PR','Status']:
   self.assertIn(value,t)
  for row in t.splitlines():
   if row.startswith('| ') and 'DONE' in row:self.assertIn('DONE (coded)',row)

 def test_review_coverage_385_to_398(self):
  rows=json.loads((ROOT/'docs/agent-control/review-status-385-398.json').read_text())
  self.assertEqual([r['pr'] for r in rows],list(range(385,399)))
  board=(ROOT/'docs/agent-control/task-board.md').read_text()
  for r in rows:
   self.assertIn(f"REC-{r['pr']}",board)
   self.assertEqual(r['review_status'], 'AWAITING CHATGPT REVIEW' if r['pr']<387 else 'NOT SAFE — fix and integration required' if r['pr'] in [390,391] else 'NOT SAFE TO MERGE YET' if r['pr']==396 else 'REVIEW REPORTED — exact individual verdict/conditions UNPROVEN')
   self.assertEqual(r['github_reviews'],[])
  gates=(ROOT/'docs/agent-control/release-gates.md').read_text()
  self.assertIn('integration=skipped',gates)
  self.assertIn('not an Xero assertion failure or an environment/resource limit',gates)
