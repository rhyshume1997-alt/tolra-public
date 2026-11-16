# ISO 9001 documents as Word files

Draft, not approved. This folder is formatting only. Each `.docx` is the markdown draft from the source PR, laid out as a Word document. No wording was added or changed, and nothing here is certification or evidence of compliance.

- Sources: `../source/*.md`, copied unchanged from the PR head commits listed in `INDEX.md` / `INDEX.docx`.
- Not included: PR #337 (`codex/b4-q4-wipe-day`) holds runbooks, not ISO 9001 documents. The other seven PRs (#335, #336, #338 to #342) hold 18 markdown files, all converted.

## Rebuild (one command, from the repo root)

    python3 docs/iso9001/word/build/build_docx.py

Needs `pandoc` and `python-docx` (`pip install python-docx`). If `soffice` (LibreOffice) and `pdftotext` are present, the script also fills page numbers into the contents list. Right-click the contents list in Word and choose Update Field to refresh it.

## What each document has

Cover block (document ID, version, prepared date, owner, effective date, next review, all taken from the markdown; where the markdown gives no value the field is `______`), an approval table with blank Prepared by / Reviewed by / Approved by rows, a contents list (Word TOC field), a header with "JNR Engineering Ltd" and the document ID, and a footer with "Page X of Y" fields and "Draft, not approved". Then the markdown body, with shaded and bordered tables. Documents with tables of five or more columns are landscape.

Font: Calibri 10.5 pt (tables 9.5 pt). Calibri is not installed on the build machine, so the PDF checks used Carlito, which has the same metrics.

The index file lists every document with ID, title, PR number, branch, source head SHA and file name.
