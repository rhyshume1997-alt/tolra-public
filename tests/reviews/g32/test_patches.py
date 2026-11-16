"""Read-only checks for Rhys's replacement controlling runbook; no operational steps run."""
import unittest,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[3]
class Controls(unittest.TestCase):
 def setUp(self):
  self.manifest=json.loads((ROOT/'docs/audit/G32-PUBLIC-DOC-INVENTORY.json').read_text())
  self.text=(ROOT/self.manifest['controlling_runbook']).read_text()
 def test_original_public_inventory_preserved(self):
  self.assertEqual(self.manifest['unique_document_versions'],458)
  self.assertTrue(all(len(d['sha'])==40 and len(d['content_sha256'])==64 for d in self.manifest['documents']))
  self.assertEqual(len(self.manifest['superseded_patch_proposals']),32)
 def test_withdrawn_patches_have_one_controlling_authority(self):
  self.assertFalse((ROOT/'docs/audit/g32-patches').exists())
  report=(ROOT/'docs/audit/G32-CUTOVER-ORDER-REVIEW.md').read_text()
  self.assertIn('SUPERSEDED',report)
  for f in self.manifest['findings']:
   self.assertEqual(f['sequence_status'],'SUPERSEDED');self.assertGreater(f['line'],0)
 def test_freeze_and_dependency_order(self):
  labels=['1. Production write freeze','2. Releases','3. Approved JNR wipe','4. No-writes preflight','5. Import once','6. Day-of DLN counter','7. Deploy exact approved SHA','8. Human release of staff access']
  indexes=[self.text.index(s) for s in labels];self.assertEqual(indexes,sorted(indexes))
  self.assertIn('138 → 140 → 141 → 144 → 145 → 146 → 147',self.text)
 def test_stop_at_each_required_checkpoint_and_no_auto_restore(self):
  for checkpoint in ['STOP AFTER WIPE','STOP AFTER IMPORT RECONCILIATION','STOP AFTER DLN VERIFICATION','STOP AFTER APP SMOKE TEST']:
   self.assertIn(checkpoint,self.text)
  for phrase in ['do not run the next dependent step','never triggers an automatic restore','Never re-apply 146 after rollback','16 rows, all true','UNPROVEN']:
   self.assertIn(phrase,self.text)
if __name__=='__main__':unittest.main()
