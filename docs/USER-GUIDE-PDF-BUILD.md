# User-guide PDF build contract

The canonical PDF must be generated from the complete canonical HTML source,
not from a short addendum. A complete source declares:

```html
<meta name="adsi-guide-source" content="complete">
```

## Generate the PDF and provenance

```powershell
npm run docs:pdf
```

Generation fails before replacing anything unless the HTML is at least 40,000
bytes and contains at least 12 level-one/level-two headings. It renders to a
temporary file and requires a valid PDF structure, at least 50,000 bytes, and
at least 10 pages.

On success, the generator installs both:

- `docs/ADSI-Dashboard-User-Guide.pdf`; and
- `docs/ADSI-Dashboard-User-Guide.pdf.provenance.json`.

The provenance sidecar records the generator/schema identity, exact HTML and
PDF SHA-256 hashes, paths, sizes, heading count, and PDF page count. Commit the
complete HTML, generated PDF, and provenance sidecar together.

## Non-mutating release verification

```powershell
npm run docs:pdf -- --check
```

Check mode does not launch Chromium, render, or change files. It validates the
complete-source contract, PDF structure/page floor, sidecar schema, and exact
source/PDF hashes. Signed installer builds run this command automatically and
fail before PyInstaller if provenance is missing or stale. Unsigned development
builds skip this release-only gate.

The normal generator keeps same-directory recovery copies during replacement.
If a post-install backup cannot be deleted, the new PDF remains installed and a
warning names the retained recovery file; it does not falsely report that the
old PDF was restored.

A complete source in another location can be selected explicitly:

```powershell
$env:ADSI_USERGUIDE_HTML = 'D:\path\to\complete-user-guide.html'
$env:ADSI_USERGUIDE_PDF = 'D:\path\to\complete-user-guide.pdf'
$env:ADSI_USERGUIDE_PROVENANCE = 'D:\path\to\complete-user-guide.pdf.provenance.json'
npm run docs:pdf
```
