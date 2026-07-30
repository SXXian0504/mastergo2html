#!/usr/bin/env python3
"""Copy standalone HTML outputs into an isolated workspace and build an inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path


class InventoryParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.heading_parts: list[str] = []
        self._capture_title = False
        self._capture_heading = False
        self.tags: Counter[str] = Counter()
        self.assets: list[str] = []
        self.links: list[str] = []
        self.stylesheets: list[str] = []
        self.scripts: list[str] = []
        self.body_classes: list[str] = []
        self.forms = 0
        self.buttons = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        self.tags[tag] += 1
        attrs_map = {key.lower(): value for key, value in attrs}
        if tag == "title":
            self._capture_title = True
        if tag in {"h1", "h2", "h3"}:
            self._capture_heading = True
        if tag == "body" and attrs_map.get("class"):
            self.body_classes = attrs_map["class"].split()
        if tag in {"img", "source", "video", "audio"} and attrs_map.get("src"):
            self.assets.append(attrs_map["src"] or "")
        if tag == "link" and attrs_map.get("href"):
            href = attrs_map["href"] or ""
            if "stylesheet" in (attrs_map.get("rel") or "").lower():
                self.stylesheets.append(href)
            else:
                self.assets.append(href)
        if tag == "a" and attrs_map.get("href"):
            self.links.append(attrs_map["href"] or "")
        if tag == "script" and attrs_map.get("src"):
            self.scripts.append(attrs_map["src"] or "")
        if tag == "form":
            self.forms += 1
        if tag == "button":
            self.buttons += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._capture_title = False
        if tag.lower() in {"h1", "h2", "h3"}:
            self._capture_heading = False

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if not value:
            return
        if self._capture_title:
            self.title_parts.append(value)
        if self._capture_heading:
            self.heading_parts.append(value)


def route_to_page_id(route: str) -> str:
    if route == "/":
        return "index"
    value = route.strip("/")
    value = re.sub(r"\[([^\]]+)\]", r"\1", value)
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return value or "index"


def parse_page_arg(raw: str) -> tuple[str, Path]:
    if "=" not in raw:
        raise ValueError(f"Expected ROUTE=PATH, received: {raw}")
    route, path = raw.split("=", 1)
    route = route.strip()
    if not route.startswith("/"):
        raise ValueError(f"Route must start with '/': {route}")
    source = Path(path).expanduser().resolve()
    if not source.exists():
        raise ValueError(f"Source does not exist: {source}")
    return route, source


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_entry(source: Path) -> Path:
    if source.is_file():
        if source.suffix.lower() not in {".html", ".htm"}:
            raise ValueError(f"Source file is not HTML: {source}")
        return source
    preferred = source / "index.html"
    if preferred.exists():
        return preferred
    html_files = sorted([*source.glob("*.html"), *source.glob("*.htm")])
    if len(html_files) != 1:
        raise ValueError(f"Expected index.html or exactly one HTML file in: {source}")
    return html_files[0]


def copy_source(source: Path, destination: Path) -> Path:
    if destination.exists():
        raise ValueError(f"Destination already exists; choose a fresh workspace: {destination}")
    if source.is_dir():
        shutil.copytree(source, destination)
        return destination
    destination.mkdir(parents=True)
    shutil.copy2(source, destination / source.name)
    return destination / source.name


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, help="Fresh or existing task workspace")
    parser.add_argument("--page", action="append", required=True, help="Final route and source as ROUTE=PATH")
    args = parser.parse_args()

    workspace = Path(args.workspace).expanduser().resolve()
    sources_root = workspace / "sources"
    sources_root.mkdir(parents=True, exist_ok=True)

    seen_routes: set[str] = set()
    seen_ids: set[str] = set()
    pages: list[dict[str, object]] = []

    try:
        parsed_pages = [parse_page_arg(raw) for raw in args.page]
        for route, source in parsed_pages:
            if route in seen_routes:
                raise ValueError(f"Duplicate route: {route}")
            seen_routes.add(route)
            page_id = route_to_page_id(route)
            if page_id in seen_ids:
                raise ValueError(f"Page ID collision after normalization: {page_id}")
            seen_ids.add(page_id)

            destination = sources_root / page_id
            copied = copy_source(source, destination)
            copied_root = destination if destination.is_dir() else destination.parent
            original_entry = find_entry(source)
            relative_entry = original_entry.relative_to(source) if source.is_dir() else Path(original_entry.name)
            entry = copied_root / relative_entry

            html = entry.read_text(encoding="utf-8", errors="replace")
            inventory = InventoryParser()
            inventory.feed(html)

            files = [path for path in copied_root.rglob("*") if path.is_file()]
            asset_files = [
                path
                for path in files
                if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".woff", ".woff2", ".ttf", ".otf"}
            ]
            missing_assets = []
            for asset in inventory.assets:
                if not asset or re.match(r"^(?:https?:|data:|//|#)", asset):
                    continue
                candidate = (entry.parent / asset.split("?", 1)[0].split("#", 1)[0]).resolve()
                if not candidate.exists():
                    missing_assets.append(asset)

            pages.append(
                {
                    "page_id": page_id,
                    "route": route,
                    "source_path": str(source),
                    "source_dir": str(copied_root),
                    "entry_html": str(entry),
                    "title": " ".join(inventory.title_parts),
                    "headings": inventory.heading_parts[:20],
                    "body_classes": inventory.body_classes,
                    "stylesheets": inventory.stylesheets,
                    "scripts": inventory.scripts,
                    "links": inventory.links,
                    "forms": inventory.forms,
                    "buttons": inventory.buttons,
                    "tag_counts": dict(sorted(inventory.tags.items())),
                    "file_count": len(files),
                    "asset_file_count": len(asset_files),
                    "total_bytes": sum(path.stat().st_size for path in files),
                    "entry_sha256": sha256(entry),
                    "missing_assets": sorted(set(missing_assets)),
                }
            )
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    manifest = {
        "schema_version": 1,
        "workspace": str(workspace),
        "pages": pages,
    }
    manifest_path = workspace / "source-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = ["# Source inventory", "", f"Pages: {len(pages)}", ""]
    for page in pages:
        report.extend(
            [
                f"## `{page['route']}` — `{page['page_id']}`",
                "",
                f"- Title: {page['title'] or '(none)'}",
                f"- Entry: `{page['entry_html']}`",
                f"- Files/assets: {page['file_count']} / {page['asset_file_count']}",
                f"- Size: {page['total_bytes']} bytes",
                f"- Forms/buttons: {page['forms']} / {page['buttons']}",
                f"- Stylesheets: {', '.join(page['stylesheets']) or '(none)'}",
                f"- Scripts: {', '.join(page['scripts']) or '(none)'}",
                f"- Missing local assets: {', '.join(page['missing_assets']) or '(none)'}",
                f"- Headings: {' | '.join(page['headings']) or '(none)'}",
                "",
            ]
        )
    (workspace / "source-inventory.md").write_text("\n".join(report), encoding="utf-8")

    print(f"Prepared {len(pages)} page(s) in {workspace}")
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
