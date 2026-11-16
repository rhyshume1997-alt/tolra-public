"""Offline document checks only. No company records or database access."""
import json
import re
import unittest
from pathlib import Path
from docx import Document

ROOT = Path(__file__).resolve().parents[3]
PACK = ROOT / 'docs/iso9001/review-supplements'

class Supplements(unittest.TestCase):
    def test_numbered_public_pack_inventory(self):
        rows = json.loads((PACK / 'public-source-index.json').read_text())
        for pr in [371, 372]:
            found = {int(m.group(1)) for r in rows if r['scope'] == f'PR #{pr}'
                     for m in [re.search(r'-QMS-(\d{3})-', r['path'])] if m}
            self.assertEqual(found, set(range(1, 29)))
        for pr in [335,336,337,338,339,340,341,360,361,363,366]:
            self.assertTrue(any(r['scope'] == f'PR #{pr}' for r in rows))
        for r in rows:
            self.assertRegex(r['sha'], r'^[a-f0-9]{40}$')
            self.assertRegex(r['sha256'], r'^[a-f0-9]{64}$')

    def test_nine_templates_keep_results_and_approval_blank(self):
        files = [p for p in PACK.glob('*.md') if p.name != 'README.md']
        self.assertEqual(len(files), 9)
        for path in files:
            text = path.read_text()
            for field in ['Requirement ID', 'Expected result', 'Actual result / status',
                          'Evidence reference', 'Tester', 'Date', 'Approval']:
                self.assertIn(field, text, str(path))
            self.assertIn('| Actual result / status | NOT EXECUTED |', text)
            self.assertIn('| Approval name / signature / date | ______ |', text)
            self.assertNotRegex(text, r'\|\s*PASS\s*\|')
            self.assertIn('Software and documents cannot make a company certified', text)
        marpet = (PACK / 'MARPET-AUDITOR-RETRIEVAL-SHEET.md').read_text()
        self.assertIn('Confirm whether Marpet uses Tolra', marpet)

    def test_three_word_copies_preserve_source_lines_and_blanks(self):
        manifest = json.loads((PACK / 'word-parity.json').read_text())
        self.assertEqual({r['source_pr'] for r in manifest}, {360,361,363})
        for r in manifest:
            lines = [p.text for p in Document(PACK / r['word_path']).paragraphs]
            self.assertEqual(lines, r['visible_lines'])
            self.assertIn('____', '\n'.join(lines))
            self.assertNotIn('Approved by Codex', '\n'.join(lines))

if __name__ == '__main__':
    unittest.main()
