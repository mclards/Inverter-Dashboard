from __future__ import annotations

import argparse
import re
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

DEFAULT_DOC_PATH = Path("docs/ADSI-Dashboard-Pricing-Summary.docx")

def resolve_input_output(description: str) -> tuple[Path, Path]:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--input",
        default=str(DEFAULT_DOC_PATH),
        help="Input DOCX path (default: docs/ADSI-Dashboard-Pricing-Summary.docx)",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output DOCX path (default: <input>.updated.docx unless --in-place)",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Write changes to --input directly",
    )
    args = parser.parse_args()

    in_path = Path(args.input).expanduser().resolve()
    if not in_path.exists():
        raise SystemExit(f"Input DOCX not found: {in_path}")

    if args.in_place and args.output:
        raise SystemExit("Use either --in-place or --output, not both.")

    if args.in_place:
        out_path = in_path
    elif args.output:
        out_path = Path(args.output).expanduser().resolve()
    else:
        out_path = in_path.with_name(f"{in_path.stem}.updated{in_path.suffix}")

    return in_path, out_path

def paragraph_text(el) -> str:
    return "".join(t.text or "" for t in el.iter(qn("w:t")))

def is_paragraph(el) -> bool:
    tag = el.tag
    return tag.endswith("}p") or tag == "w:p"

def is_table(el) -> bool:
    tag = el.tag
    return tag.endswith("}tbl") or tag == "w:tbl"

def paragraph_matches(el, pattern: str, startswith: bool = False, case_insensitive: bool = True) -> bool:
    if not is_paragraph(el):
        return False
    text = paragraph_text(el).strip()
    if case_insensitive:
        text_cmp = text.lower()
        pat_cmp = pattern.lower()
    else:
        text_cmp = text
        pat_cmp = pattern
    if startswith:
        return text_cmp.startswith(pat_cmp)
    return pat_cmp in text_cmp

def find_first_paragraph(doc: Document, matcher) -> object:
    for p in doc.paragraphs:
        if matcher(p.text or ""):
            return p._element
    return None

def numbered_heading_text(text: str) -> bool:
    return bool(re.match(r"^\s*\d{2}(?:-[A-Z])?\.\s+", (text or "").strip()))

def find_next_numbered_heading(start_el) -> object:
    cur = start_el.getnext()
    while cur is not None:
        if is_paragraph(cur):
            txt = paragraph_text(cur).strip()
            if numbered_heading_text(txt):
                return cur
        cur = cur.getnext()
    return None

def collect_siblings_until(start_after_el, stop_before_el) -> list[object]:
    out = []
    cur = start_after_el.getnext()
    while cur is not None and cur is not stop_before_el:
        out.append(cur)
        cur = cur.getnext()
    return out

def collect_from_to(start_el, stop_before_el) -> list[object]:
    out = []
    cur = start_el
    while cur is not None and cur is not stop_before_el:
        out.append(cur)
        cur = cur.getnext()
    return out

def remove_elements(body_el, elements: list[object]) -> None:
    for el in elements:
        body_el.remove(el)

def insert_before(anchor_el, elements_in_order: list[object]) -> None:
    for el in reversed(elements_in_order):
        anchor_el.addprevious(el)

def insert_after(anchor_el, elements_in_order: list[object]) -> object:
    ref = anchor_el
    for el in elements_in_order:
        ref.addnext(el)
        ref = el
    return ref

def make_spacer(after_twips: int = 80):
    new_p = OxmlElement("w:p")
    p_pr = OxmlElement("w:pPr")
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:after"), str(int(after_twips)))
    p_pr.append(spacing)
    new_p.append(p_pr)
    return new_p

