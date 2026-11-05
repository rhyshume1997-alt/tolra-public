"""Offline draft-patch verification; source corpus is public cached text, never a database."""
import unittest,json,pathlib,tempfile,subprocess,hashlib,os
ROOT=pathlib.Path(__file__).resolve().parents[3]
class Patches(unittest.TestCase):
 def setUp(self):
  self.manifest=json.loads((ROOT/'docs/audit/G32-PUBLIC-DOC-INVENTORY.json').read_text())
 def test_every_read_is_pinned(self):
  self.assertEqual(self.manifest['unique_document_versions'],458)
  self.assertTrue(all(len(d['sha'])==40 and len(d['content_sha256'])==64 for d in self.manifest['documents']))
 def test_every_finding_has_an_existing_patch_and_positive_line(self):
  self.assertTrue(self.manifest['findings'])
  for row in self.manifest['findings']:
   self.assertGreater(row['line'],0);self.assertTrue((ROOT/'docs/audit/g32-patches'/row['patch']).is_file())
 def test_all_patches_apply_to_the_exact_reviewed_text(self):
  corpus=json.loads(pathlib.Path(os.environ.get('G32_PUBLIC_CORPUS','/tmp/g32-public-docs.json')).read_text())
  by_blob={x['blob']:x for x in corpus}
  for p in self.manifest['patches']:
   original=by_blob[p['source_blob']]['text'];self.assertEqual(hashlib.sha256(original.encode()).hexdigest(),p['source_sha256'])
   with tempfile.TemporaryDirectory(prefix='g32-public-patch-') as temp:
    target=pathlib.Path(temp,p['path']);target.parent.mkdir(parents=True,exist_ok=True);target.write_text(original)
    patch=ROOT/'docs/audit/g32-patches'/p['patch']
    subprocess.run(['git','apply','--check',str(patch)],cwd=temp,check=True,capture_output=True)
    subprocess.run(['git','apply',str(patch)],cwd=temp,check=True,capture_output=True)
    result=target.read_text();self.assertIn('138 → 140 → 141 → 144 → 145 → 146 → 147',result)
    self.assertIn('supersedes every older cutover sequence',result)
if __name__=='__main__':unittest.main()
