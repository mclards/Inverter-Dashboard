"""Reorder the perpetual section using anchor-aware, index-free logic."""

from __future__ import annotations

from docx import Document
from docx.oxml.ns import qn

from _docx_utils import (
    collect_from_to,
    find_first_paragraph,
    find_next_numbered_heading,
    insert_before,
    is_paragraph,
    is_table,
    make_spacer,
    paragraph_text,
    remove_elements,
    resolve_input_output,
)

def _row_count(tbl_el) -> int:
    return len(tbl_el.findall(qn("w:tr")))

def _classify(elements: list[object]) -> dict[str, object]:
    out = {
        "heading_01b": None,
        "intro": None,
        "compare_heading": None,
        "aftermarket_note": None,
        "pricing_table": None,
        "compare_table": None,
    }
    for el in elements:
        if is_table(el):
            rows = _row_count(el)
            if rows == 3 and out["pricing_table"] is None:
                out["pricing_table"] = el
            elif rows == 7 and out["compare_table"] is None:
                out["compare_table"] = el
            continue

        if not is_paragraph(el):
            continue
        txt = paragraph_text(el).strip().lower()
        if "01-b. perpetual license option" in txt and out["heading_01b"] is None:
            out["heading_01b"] = el
        elif "one-time capital expenditure" in txt and out["intro"] is None:
            out["intro"] = el
        elif "perpetual vs subscription" in txt and out["compare_heading"] is None:
            out["compare_heading"] = el
        elif (
            "customization, additional features" in txt
            and "subscription scope" in txt
            and out["aftermarket_note"] is None
        ):
            out["aftermarket_note"] = el
    return out

def reorder(doc: Document) -> tuple[bool, str]:
    body = doc.element.body

    sec_aftermarket = find_first_paragraph(
        doc, lambda t: (t or "").strip().startswith("03. After-Market")
    ) or find_first_paragraph(
        doc, lambda t: (t or "").strip().startswith("04. After-Market")
    )
    if sec_aftermarket is None:
        return False, "No After-Market section heading found."

    start = find_first_paragraph(
        doc, lambda t: "01-B. Perpetual License Option" in (t or "")
    )
    if start is None:
        # Fallback: if 01-B heading is missing, try the compare heading as start.
        start = find_first_paragraph(doc, lambda t: "Perpetual vs Subscription" in (t or ""))
    if start is None:
        return False, "No perpetual section markers found."

    # Ensure we only touch content before the next numbered heading.
    next_heading = find_next_numbered_heading(start)
    if next_heading is not None and next_heading is not sec_aftermarket:
        stop = next_heading
    else:
        stop = sec_aftermarket

    block = collect_from_to(start, stop)
    if not block:
        return False, "Perpetual block is empty."

    classified = _classify(block)

    ordered = []
    if classified["aftermarket_note"] is not None:
        ordered.append(classified["aftermarket_note"])
        ordered.append(make_spacer())
    if classified["heading_01b"] is not None:
        ordered.append(classified["heading_01b"])
        ordered.append(make_spacer())
    if classified["intro"] is not None:
        ordered.append(classified["intro"])
        ordered.append(make_spacer())
    if classified["pricing_table"] is not None:
        ordered.append(classified["pricing_table"])
        ordered.append(make_spacer())
    if classified["compare_heading"] is not None:
        ordered.append(classified["compare_heading"])
        ordered.append(make_spacer())
    if classified["compare_table"] is not None:
        ordered.append(classified["compare_table"])
        ordered.append(make_spacer())

    if len(ordered) < 3:
        return False, "Could not classify enough perpetual section elements to reorder safely."

    remove_elements(body, block)
    insert_before(sec_aftermarket, ordered)
    return True, "Perpetual section reordered."

def main() -> int:
    in_path, out_path = resolve_input_output("Reorder perpetual section safely.")
    doc = Document(str(in_path))
    changed, msg = reorder(doc)
    if not changed:
        print(f"SKIPPED: {msg}")
        if out_path != in_path:
            doc.save(str(out_path))
            print(f"Saved unmodified copy: {out_path}")
        return 1
    doc.save(str(out_path))
    print(f"DONE: {msg}")
    print(f"Saved: {out_path}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

