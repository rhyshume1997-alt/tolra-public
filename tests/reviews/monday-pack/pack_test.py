import pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[3]
class Pack(unittest.TestCase):
 def setUp(self):self.text=(ROOT/'docs/agent-control/MONDAY-EVIDENCE-PACK-2026-11-09.md').read_text()
 def test_requested_sections_and_missing_values_explicit(self):
  for field in ['Exact final approved candidate SHA','Passed, failed and skipped','Unreconciled','Approved deviations','Backup ID/time/hash','accepted RPO / RTO','Named human decisions','Final approval/signature: UNPROVEN']:
   self.assertIn(field,self.text)
  self.assertNotIn('|  |',self.text)
 def test_known_red_review_gates_not_promoted(self):
  for phrase in ['2 / 4 / 0','NOT SAFE until fixed and integrated','not safe to merge yet','No blanket SAFE','Never automatically restore']:
   self.assertIn(phrase,self.text)
 def test_no_final_candidate_or_live_reconciliation_invented(self):
  self.assertIn('no combined approved candidate supplied',self.text)
  self.assertIn('do not fill in zero without a checked result',self.text)
  self.assertIn('actual scenario B comparison is private, owned by Code',self.text)
  self.assertIn('Extra migration scope/order',self.text)
if __name__=='__main__':unittest.main()
