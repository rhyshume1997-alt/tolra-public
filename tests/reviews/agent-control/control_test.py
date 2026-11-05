import pathlib, subprocess, unittest
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
