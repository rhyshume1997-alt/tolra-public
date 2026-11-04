#!/usr/bin/env python3
"""Build Word (.docx) versions of the ISO 9001 markdown sources.

Formatting only: the markdown body is converted unchanged by pandoc, then
python-docx adds a cover block, approval table, contents field, header,
footer and table styling. No wording is added except the cover/approval
labels, the header/footer text and the contents list (copied from headings).

Run:  python3 docs/iso9001/word/build/build_docx.py
Needs: pandoc, python-docx. Optional: soffice + pdftotext (TOC page numbers).
"""
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

HERE = Path(__file__).resolve().parent
WORD = HERE.parent
SRC = WORD.parent / "source"
FONT = "Calibri"      # Word users have it; LibreOffice renders with metric-compatible Carlito
BODY_PT = 10.5
TABLE_PT = 9.5
NAVY = "1F3864"
HEAD_FILL = "D9E2F3"
BORDER = "7F7F7F"
BLANK = "______"


# ---------- low-level helpers ----------
def get_style(styles, name):
    for s in styles:
        if s.name.lower() == name.lower():
            return s
    raise KeyError(name)


def set_font(style_or_run, size=None, bold=None, color=None, name=FONT):
    f = style_or_run.font
    f.name = name
    rpr = style_or_run.element.get_or_add_rPr() if hasattr(style_or_run.element, "get_or_add_rPr") else style_or_run._r.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.insert(0, rf)
    for a in list(rf.attrib):
        del rf.attrib[a]
    for a in ("ascii", "hAnsi", "cs", "eastAsia"):
        rf.set(qn("w:" + a), name)
    if size:
        f.size = Pt(size)
    if bold is not None:
        f.bold = bold
    if color:
        f.color.rgb = RGBColor.from_string(color)


def shade(cell, fill):
    tcpr = cell._tc.get_or_add_tcPr()
    for old in tcpr.findall(qn("w:shd")):
        tcpr.remove(old)
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcpr.append(shd)


def borders(tbl_el):
    tblpr = tbl_el.tblPr
    for old in tblpr.findall(qn("w:tblBorders")):
        tblpr.remove(old)
    b = OxmlElement("w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement("w:" + side)
        e.set(qn("w:val"), "single")
        e.set(qn("w:sz"), "4")
        e.set(qn("w:space"), "0")
        e.set(qn("w:color"), BORDER)
        b.append(e)
    tblpr.append(b)


def cell_margins(tbl_el):
    tblpr = tbl_el.tblPr
    m = OxmlElement("w:tblCellMar")
    for side, w in (("top", 40), ("left", 80), ("bottom", 40), ("right", 80)):
        e = OxmlElement("w:" + side)
        e.set(qn("w:w"), str(w))
        e.set(qn("w:type"), "dxa")
        m.append(e)
    tblpr.append(m)


def fixed_layout(tbl_el, widths_cm):
    tblpr = tbl_el.tblPr
    for tag in ("w:tblLayout", "w:tblW"):
        for old in tblpr.findall(qn(tag)):
            tblpr.remove(old)
    lay = OxmlElement("w:tblLayout")
    lay.set(qn("w:type"), "fixed")
    tblpr.append(lay)
    tw = OxmlElement("w:tblW")
    tw.set(qn("w:w"), str(int(sum(widths_cm) / 2.54 * 1440)))
    tw.set(qn("w:type"), "dxa")
    tblpr.append(tw)
    grid = tbl_el.find(qn("w:tblGrid"))
    if grid is not None:
        for gc, w in zip(grid.findall(qn("w:gridCol")), widths_cm):
            gc.set(qn("w:w"), str(int(w / 2.54 * 1440)))


def add_field(par, instr, placeholder="1", size=None):
    def run_with(el):
        r = par.add_run()
        if size:
            r.font.size = Pt(size)
        r._r.append(el)
        return r
    b = OxmlElement("w:fldChar"); b.set(qn("w:fldCharType"), "begin"); run_with(b)
    i = OxmlElement("w:instrText"); i.set(qn("xml:space"), "preserve"); i.text = f" {instr} "; run_with(i)
    s = OxmlElement("w:fldChar"); s.set(qn("w:fldCharType"), "separate"); run_with(s)
    r = par.add_run(placeholder)
    if size:
        r.font.size = Pt(size)
    e = OxmlElement("w:fldChar"); e.set(qn("w:fldCharType"), "end"); run_with(e)


def para_border_bottom(par, color=NAVY, sz="8"):
    ppr = par._p.get_or_add_pPr()
    pb = OxmlElement("w:pBdr")
    bt = OxmlElement("w:bottom")
    bt.set(qn("w:val"), "single"); bt.set(qn("w:sz"), sz); bt.set(qn("w:space"), "1"); bt.set(qn("w:color"), color)
    pb.append(bt)
    ppr.append(pb)


def page_break_par(doc):
    p = doc.add_paragraph()
    p.add_run().add_break(__import__("docx").enum.text.WD_BREAK.PAGE)
    return p


BR_TOKEN = "QFBREAKQF"


def restore_breaks(doc):
    for t in list(doc.element.body.iter(qn("w:t"))):
        if t.text and BR_TOKEN in t.text:
            r = t.getparent()
            parts = t.text.split(BR_TOKEN)
            t.text = parts[0]
            t.set(qn("xml:space"), "preserve")
            prev = r
            for part in parts[1:]:
                nr = copy.deepcopy(r)
                for ch in list(nr):
                    if ch.tag != qn("w:rPr"):
                        nr.remove(ch)
                br = OxmlElement("w:br"); nr.append(br)
                nt = OxmlElement("w:t"); nt.text = part; nt.set(qn("xml:space"), "preserve"); nr.append(nt)
                prev.addnext(nr)
                prev = nr


# ---------- source parsing ----------
def parse_source(text):
    title = re.search(r"^# (.+)$", text, re.M).group(1).strip()
    m = re.search(r"Document ID:\s*([^|\n]+?)\s*\|\s*Version:\s*([^|\n]+?)\s*\|\s*Prepared:\s*([^\n]+)", text)
    doc_id, version, prepared = (m.group(1), m.group(2), m.group(3).strip()) if m else (None, None, None)
    om = re.search(r"^((?:Proposed owner|Owner):.*)$", text, re.M)
    owner = om.group(1).strip() if om else None
    return dict(title=title, doc_id=doc_id, version=version, prepared=prepared, owner=owner)


def widest_table_cols(text):
    n = 0
    for line in text.splitlines():
        if line.startswith("|") and re.match(r"^\|(\s*:?-+:?\s*\|)+\s*$", line):
            n = max(n, line.count("|") - 1)
    return n


# ---------- body styling ----------
def style_document(doc, landscape):
    st = doc.styles
    set_font(get_style(st, "Normal"), BODY_PT)
    for name in ("Body Text", "First Paragraph", "Compact"):
        if name in [x.name for x in st]:
            s = get_style(st, name)
            set_font(s, BODY_PT)
            s.paragraph_format.space_after = Pt(6 if name != "Compact" else 2)
            s.paragraph_format.space_before = Pt(0)
    for name, size in (("Heading 1", 16), ("Heading 2", 13), ("Heading 3", 11.5)):
        s = get_style(st, name)
        set_font(s, size, bold=True, color=NAVY)
        s.paragraph_format.space_before = Pt(14 if name == "Heading 1" else 10)
        s.paragraph_format.space_after = Pt(4)
        s.paragraph_format.keep_with_next = True
    if "Verbatim Char" in [x.name for x in st]:
        vc = get_style(st, "Verbatim Char")
        vc.font.size = Pt(9.5)
    for name in ("Hyperlink",):
        if name in [x.name for x in st]:
            get_style(st, name).font.color.rgb = RGBColor.from_string("1F4E9E")
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    if landscape:
        sec.orientation = WD_ORIENT.LANDSCAPE
        sec.page_width, sec.page_height = Cm(29.7), Cm(21.0)
    sec.left_margin = sec.right_margin = Cm(2.0)
    sec.top_margin = Cm(2.2)
    sec.bottom_margin = Cm(2.0)
    sec.header_distance = Cm(1.0)
    sec.footer_distance = Cm(1.0)
    return (sec.page_width - sec.left_margin - sec.right_margin) / 360000.0  # cm


def style_tables(doc, total_cm):
    for t in doc.tables:
        tbl = t._tbl
        ncols = len(t.columns)
        rows = [[c.text for c in r.cells] for r in t.rows]
        mins, weights = [], []
        for j in range(ncols):
            col = [r[j] for r in rows if j < len(r)]
            longest = max((len(w) for c in col for w in c.split()), default=4)
            mins.append(min(longest, 28) * 0.19 + 0.35)
            avg = sum(len(c) for c in col) / max(len(col), 1)
            weights.append(min(max(avg, 6), 70))
        if sum(mins) > total_cm:
            f = total_cm / sum(mins)
            widths = [m * f for m in mins]
        else:
            spare = total_cm - sum(mins)
            widths = [m + spare * w / sum(weights) for m, w in zip(mins, weights)]
        fixed_layout(tbl, widths)
        borders(tbl)
        cell_margins(tbl)
        t.alignment = WD_TABLE_ALIGNMENT.LEFT
        for ri, row in enumerate(t.rows):
            trpr = row._tr.get_or_add_trPr()
            cs = OxmlElement("w:cantSplit"); trpr.append(cs)
            if ri == 0:
                th = OxmlElement("w:tblHeader"); trpr.append(th)
            for ci, cell in enumerate(row.cells):
                cell.width = Cm(widths[ci])
                if ri == 0:
                    shade(cell, HEAD_FILL)
                for p in cell.paragraphs:
                    p.paragraph_format.space_after = Pt(0)
                    p.paragraph_format.space_before = Pt(0)
                    for r in p.runs:
                        r.font.size = Pt(TABLE_PT)
                        if ri == 0:
                            r.font.bold = True
        # spacing after the table is provided by the following paragraph's style


# ---------- cover / contents / header / footer ----------
def kv_table(doc, rows, widths):
    t = doc.add_table(rows=0, cols=2)
    for k, v in rows:
        cells = t.add_row().cells
        cells[0].text = ""
        cells[1].text = ""
        r = cells[0].paragraphs[0].add_run(k); r.bold = True
        cells[1].paragraphs[0].add_run(v)
        shade(cells[0], HEAD_FILL)
    fixed_layout(t._tbl, widths)
    borders(t._tbl)
    cell_margins(t._tbl)
    for row in t.rows:
        for ci, c in enumerate(row.cells):
            c.width = Cm(widths[ci])
            for p in c.paragraphs:
                p.paragraph_format.space_after = Pt(0)
                for r in p.runs:
                    r.font.size = Pt(BODY_PT)
    return t


def build_front(doc, meta, headings, toc_pages, total_cm):
    """Return list of body elements (cover, approvals, contents) in order."""
    start = len(doc.element.body) - 1  # sectPr is last child; new elements go before it
    # Cover
    sp = doc.add_paragraph(); sp.paragraph_format.space_before = Pt(60)
    r = sp.add_run("JNR Engineering Ltd"); set_font(r, 12, bold=True, color="595959")
    p = doc.add_paragraph()
    r = p.add_run(meta["title"]); set_font(r, 26, bold=True, color=NAVY)
    p.paragraph_format.space_after = Pt(6)
    para_border_bottom(p)
    sp2 = doc.add_paragraph(); sp2.paragraph_format.space_after = Pt(10)
    k = total_cm
    rows = [
        ("Document ID", meta["doc_id"] or BLANK),
        ("Version", meta["version"] or "Draft 0.1 (placeholder, not stated in source)"),
        ("Prepared", meta["prepared"] or BLANK),
        ("Owner", meta["owner"] or BLANK),
        ("Effective date", BLANK),
        ("Next review", BLANK),
    ]
    kv_table(doc, rows, [4.0, k - 4.0])
    sp3 = doc.add_paragraph(); sp3.paragraph_format.space_after = Pt(14)
    t = doc.add_table(rows=1, cols=4)
    for c, h in zip(t.rows[0].cells, ("Approval", "Name", "Signature", "Date")):
        c.text = ""
        r = c.paragraphs[0].add_run(h); r.bold = True; r.font.size = Pt(BODY_PT)
        shade(c, HEAD_FILL)
    for role in ("Prepared by", "Reviewed by", "Approved by"):
        cells = t.add_row().cells
        for c in cells:
            c.text = ""
        r = cells[0].paragraphs[0].add_run(role); r.font.size = Pt(BODY_PT)
    w = [3.4, (k - 3.4) * 0.38, (k - 3.4) * 0.38, (k - 3.4) * 0.24]
    fixed_layout(t._tbl, w)
    borders(t._tbl)
    cell_margins(t._tbl)
    for ri, row in enumerate(t.rows):
        for ci, c in enumerate(row.cells):
            c.width = Cm(w[ci])
        if ri:
            trpr = row._tr.get_or_add_trPr()
            h = OxmlElement("w:trHeight"); h.set(qn("w:val"), str(int(1.3 / 2.54 * 1440))); h.set(qn("w:hRule"), "atLeast")
            trpr.append(h)
    page_break_par(doc)
    # Contents
    p = doc.add_paragraph()
    r = p.add_run("Contents"); set_font(r, 16, bold=True, color=NAVY)
    p.paragraph_format.space_after = Pt(8)
    st = doc.styles
    for lvl, ind in ((1, 0), (2, 0.6), (3, 1.2)):
        nm = f"TOC {lvl}"
        if nm not in [x.name for x in st]:
            s = st.add_style(nm, 1)
            s.base_style = get_style(st, "Normal")
        s = get_style(st, nm)
        s.paragraph_format.left_indent = Cm(ind)
        s.paragraph_format.space_after = Pt(2)
        s.paragraph_format.tab_stops.add_tab_stop(Cm(total_cm), alignment=2, leader=1)  # right, dots
        set_font(s, BODY_PT)
    entries = headings or [(1, meta["title"])]
    for i, (lvl, text) in enumerate(entries):
        par = doc.add_paragraph(style=f"TOC {min(lvl, 3)}")
        if i == 0:
            b = OxmlElement("w:fldChar"); b.set(qn("w:fldCharType"), "begin"); par.add_run()._r.append(b)
            ins = OxmlElement("w:instrText"); ins.set(qn("xml:space"), "preserve"); ins.text = ' TOC \\o "1-3" \\h \\z \\u '; par.add_run()._r.append(ins)
            s_ = OxmlElement("w:fldChar"); s_.set(qn("w:fldCharType"), "separate"); par.add_run()._r.append(s_)
        par.add_run(text)
        pg = toc_pages.get(text)
        if pg:
            par.add_run("\t" + str(pg))
        if i == len(entries) - 1:
            e = OxmlElement("w:fldChar"); e.set(qn("w:fldCharType"), "end"); par.add_run()._r.append(e)
    page_break_par(doc)
    els = list(doc.element.body)[start:]
    # drop the sectPr that python-docx keeps last
    els = [e for e in els if e.tag != qn("w:sectPr")]
    return els


def header_footer(doc, doc_id, total_cm):
    sec = doc.sections[0]
    h = sec.header; h.is_linked_to_previous = False
    p = h.paragraphs[0]; p.text = ""; p.style = get_style(doc.styles, "Normal")
    p.paragraph_format.tab_stops.add_tab_stop(Cm(total_cm), alignment=2)
    r = p.add_run("JNR Engineering Ltd"); set_font(r, 9, bold=True, color="595959")
    r = p.add_run("\t" + (doc_id or "")); set_font(r, 9, color="595959")
    para_border_bottom(p, "A6A6A6", "4")
    f = sec.footer; f.is_linked_to_previous = False
    p = f.paragraphs[0]; p.text = ""; p.style = get_style(doc.styles, "Normal")
    p.paragraph_format.tab_stops.add_tab_stop(Cm(total_cm), alignment=2)
    p.add_run("Page ").font.size = Pt(9)
    add_field(p, "PAGE", "1", 9)
    p.add_run(" of ").font.size = Pt(9)
    add_field(p, "NUMPAGES", "1", 9)
    r = p.add_run("\tDraft, not approved"); r.font.size = Pt(9)
    for r in p.runs:
        set_font(r, 9, color="595959")


def collect_headings(doc):
    out = []
    for p in doc.paragraphs:
        m = re.match(r"Heading (\d)$", p.style.name)
        if m:
            out.append((int(m.group(1)), p.text.strip()))
    return out


# ---------- build ----------
def build_one(md_path, out_path, toc_pages=None):
    text = md_path.read_text(encoding="utf-8")
    meta = parse_source(text)
    landscape = widest_table_cols(text) >= 5
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "raw.docx"
        tmp_md = Path(td) / "src.md"
        # <br> is raw HTML that pandoc drops for docx; swap for a token, restored as a Word line break
        tmp_md.write_text(re.sub(r"<br\s*/?>", BR_TOKEN, text), encoding="utf-8")
        subprocess.run(["pandoc", str(tmp_md), "-f", "markdown-smart", "-o", str(raw)], check=True)
        doc = Document(str(raw))
    restore_breaks(doc)
    total = style_document(doc, landscape)
    headings = collect_headings(doc)
    style_tables(doc, total)
    els = build_front(doc, meta, headings, toc_pages or {}, total)
    body = doc.element.body
    first = body[0]
    # move front matter ahead of the converted body
    for e in els:
        body.remove(e)
    for e in els:
        first.addprevious(e)
    header_footer(doc, meta["doc_id"], total)
    doc.core_properties.title = meta["title"]
    doc.core_properties.author = ""
    doc.core_properties.comments = "Draft, not approved. Formatting of the markdown source only."
    doc.save(str(out_path))
    return meta, headings


def toc_pages_from_pdf(docx_path, headings):
    """Optional: find page numbers of headings via LibreOffice PDF render."""
    if not (shutil.which("soffice") and shutil.which("pdftotext")):
        return {}
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", td, str(docx_path)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pdf = Path(td) / (docx_path.stem + ".pdf")
        txt = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
    pages = txt.split("\f")
    norm = lambda s: re.sub(r"\s+", " ", s).strip()
    res, cur = {}, 2  # contents is page 2; body starts on page 3
    for _, h in headings:
        for pg in range(max(cur, 2), len(pages)):
            if norm(h)[:60] in norm(pages[pg]) and (pg + 1) > 2:
                # skip the contents page itself (index 1)
                if pg == 1:
                    continue
                res[h] = pg + 1
                cur = pg
                break
    return res


def main():
    sources = json.loads((HERE / "sources.json").read_text())
    idx = []
    for name, pr, branch, sha in sources:
        md = SRC / name
        out = WORD / (md.stem + ".docx")
        meta, headings = build_one(md, out)
        pages = toc_pages_from_pdf(out, headings)
        if pages:
            build_one(md, out, pages)
        idx.append(dict(file=md.stem, docx=out.name, md=name, pr=pr, branch=branch, sha=sha, **meta))
        print("built", out.name)
    build_index(idx)


def build_index(idx):
    idx.sort(key=lambda d: (d["doc_id"] or d["file"]))
    # Markdown
    lines = ["# ISO 9001 Word pack: index", "",
             "Draft, not approved. Formatting only: each .docx is a reformatted copy of the markdown draft in the listed PR, at the listed head commit. No wording was added or changed.", "",
             "| Document ID | Title | Source PR | Source branch | Source head SHA | Word file |",
             "| --- | --- | --- | --- | --- | --- |"]
    for d in idx:
        lines.append(f"| {d['doc_id']} | {d['title']} | #{d['pr']} | `{d['branch']}` | `{d['sha']}` | {d['docx']} |")
    (WORD / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    # Word: same markdown through the same styling, landscape, no cover
    doc = Document()
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = Cm(29.7), Cm(21.0)
    sec.left_margin = sec.right_margin = Cm(2.0)
    set_font(get_style(doc.styles, "Normal"), BODY_PT)
    set_font(get_style(doc.styles, "Heading 1"), 16, bold=True, color=NAVY)
    total = 25.7
    doc.add_heading("ISO 9001 Word pack: index", level=1)
    doc.add_paragraph("Draft, not approved. Formatting only: each .docx is a reformatted copy of the markdown draft in the listed PR, at the listed head commit. No wording was added or changed.")
    hdr = ("Document ID", "Title", "Source PR", "Source branch", "Source head SHA", "Word file")
    t = doc.add_table(rows=1, cols=len(hdr))
    for c, h in zip(t.rows[0].cells, hdr):
        c.text = h
    for d in idx:
        cells = t.add_row().cells
        for c, v in zip(cells, (d["doc_id"], d["title"], "#" + str(d["pr"]), d["branch"], d["sha"], d["docx"])):
            c.text = str(v)
    style_tables(doc, total)
    header_footer(doc, "INDEX", total)
    doc.save(str(WORD / "INDEX.docx"))
    print("built INDEX.docx / INDEX.md")


if __name__ == "__main__":
    sys.exit(main())
