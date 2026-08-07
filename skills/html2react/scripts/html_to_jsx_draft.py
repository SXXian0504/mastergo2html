#!/usr/bin/env python3
"""Create mechanical JSX drafts from a prepare_inputs.py manifest."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ATTR_REPLACEMENTS = {
    "class": "className",
    "for": "htmlFor",
    "tabindex": "tabIndex",
    "maxlength": "maxLength",
    "minlength": "minLength",
    "readonly": "readOnly",
    "colspan": "colSpan",
    "rowspan": "rowSpan",
    "autofocus": "autoFocus",
    "autocomplete": "autoComplete",
    "srcset": "srcSet",
    "crossorigin": "crossOrigin",
}
VOID_TAGS = "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr"


def extract_body(html: str) -> str:
    match = re.search(r"<body\b[^>]*>([\s\S]*?)</body\s*>", html, flags=re.IGNORECASE)
    return match.group(1) if match else html


def convert_markup(markup: str, page_id: str) -> tuple[str, list[str]]:
    warnings: list[str] = []
    markup = re.sub(r"<script\b[\s\S]*?</script\s*>", "", markup, flags=re.IGNORECASE)
    markup = re.sub(r"<!--([\s\S]*?)-->", "", markup)
    markup = re.sub(r"\s+on[a-zA-Z]+\s*=\s*(?:\"[^\"]*\"|'[^']*')", "", markup)

    for html_attr, jsx_attr in ATTR_REPLACEMENTS.items():
        markup = re.sub(rf"(?<=\s){html_attr}(?=\s*=)", jsx_attr, markup, flags=re.IGNORECASE)

    markup = re.sub(
        r'(?P<attr>src|href)=(?P<quote>["\'])assets/',
        rf'\g<attr>=\g<quote>/design/{page_id}/assets/',
        markup,
        flags=re.IGNORECASE,
    )
    markup = re.sub(rf"<({VOID_TAGS})(\b[^<>]*?)(?<!/)>", r"<\1\2 />", markup, flags=re.IGNORECASE)

    if re.search(r"\sstyle\s*=", markup, flags=re.IGNORECASE):
        warnings.append("inline style attributes require conversion to JSX style objects or classes")
    if "href=\"#\"" in markup or "href='#'" in markup:
        warnings.append("placeholder href values require route decisions")
    if re.search(r"\{[^}]*\}", markup):
        warnings.append("literal braces may need JSX escaping")
    return markup.strip(), warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    manifest_path = Path(args.manifest).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)

    report = ["# JSX draft report", "", "Drafts are mechanical starting points, not production components.", ""]
    for page in manifest.get("pages", []):
        page_id = page["page_id"]
        entry = Path(page["entry_html"])
        html = entry.read_text(encoding="utf-8", errors="replace")
        body = extract_body(html)
        markup, warnings = convert_markup(body, page_id)
        page_dir = output / page_id
        page_dir.mkdir(parents=True, exist_ok=True)
        component_name = "".join(part.capitalize() for part in re.split(r"[^a-zA-Z0-9]+", page_id) if part) + "Draft"
        component = (
            f"export function {component_name}() {{\n"
            "  return (\n"
            f"    <div className=\"route-{page_id}\">\n"
            f"{markup}\n"
            "    </div>\n"
            "  );\n"
            "}\n"
        )
        (page_dir / "PageDraft.tsx").write_text(component, encoding="utf-8")

        for stylesheet in page.get("stylesheets", []):
            source = (entry.parent / stylesheet).resolve()
            if source.exists() and source.is_file():
                (page_dir / source.name).write_bytes(source.read_bytes())
        for script in page.get("scripts", []):
            source = (entry.parent / script).resolve()
            if source.exists() and source.is_file():
                (page_dir / f"source-{source.name}").write_bytes(source.read_bytes())

        report.extend(
            [
                f"## {page['route']}",
                "",
                f"- Draft: `{page_dir / 'PageDraft.tsx'}`",
                f"- Warnings: {'; '.join(warnings) or '(none)' }",
                "",
            ]
        )

    (output / "draft-report.md").write_text("\n".join(report), encoding="utf-8")
    print(f"Created drafts in {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
