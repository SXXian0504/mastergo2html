#!/usr/bin/env python3
"""Validate the structural engineering contract for a merged Next.js project."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


class Results:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.passes: list[str] = []

    def require(self, condition: bool, message: str) -> None:
        (self.passes if condition else self.errors).append(message)

    def warn(self, condition: bool, message: str) -> None:
        if not condition:
            self.warnings.append(message)


def route_file(project: Path, route: str) -> Path:
    if route == "/":
        return project / "src/app/page.tsx"
    return project / "src/app" / route.strip("/") / "page.tsx"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(read_text(path))
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--visual-report-dir")
    parser.add_argument("--require-visual", action="store_true")
    args = parser.parse_args()

    project = Path(args.project).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser().resolve()
    visual_report_dir = Path(args.visual_report_dir).expanduser().resolve() if args.visual_report_dir else None
    results = Results()

    results.require(project.is_dir(), f"Project directory exists: {project}")
    results.require(manifest_path.is_file(), f"Manifest exists: {manifest_path}")
    if results.errors:
        for error in results.errors:
            print(f"ERROR: {error}")
        return 1

    manifest = json.loads(read_text(manifest_path))
    if args.require_visual:
        results.require(visual_report_dir is not None, "Visual report directory is provided")
    package_path = project / "package.json"
    results.require(package_path.exists(), "package.json exists")
    package = json.loads(read_text(package_path)) if package_path.exists() else {}
    dependencies = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    for dependency in ("next", "react", "react-dom", "typescript"):
        results.require(dependency in dependencies, f"Dependency declared: {dependency}")
    scripts = package.get("scripts", {})
    for script in ("dev", "build", "lint", "typecheck"):
        results.require(script in scripts, f"Package script declared: {script}")

    tsconfig_path = project / "tsconfig.json"
    results.require(tsconfig_path.exists(), "tsconfig.json exists")
    tsconfig_text = read_text(tsconfig_path)
    results.require('"@/*"' in tsconfig_text and '"./src/*"' in tsconfig_text, "TypeScript alias maps @/* to src/*")

    for required in (
        "src/app/layout.tsx",
        "src/styles/globals.css",
        "src/components/layouts",
        "src/components/in-page",
        "src/components/universal",
        "src/hooks",
        "src/utils",
        "src/types",
        "src/constants",
        "config",
        "public/design",
    ):
        results.require((project / required).exists(), f"Required project path exists: {required}")

    for doc in ("ARCHITECTURE.md", "STANDARDS.md", "ROUTES.md", "DECISIONS.md"):
        results.require((project / "docs" / doc).exists(), f"Engineering document exists: docs/{doc}")

    for page in manifest.get("pages", []):
        route = page["route"]
        page_id = page["page_id"]
        path = route_file(project, route)
        results.require(path.exists(), f"Route file exists for {route}: {path.relative_to(project)}")
        results.require((project / "public/design" / page_id).exists(), f"Asset namespace exists for {route}: public/design/{page_id}")
        design_reference = page.get("design_reference")
        reference_path = None
        if isinstance(design_reference, dict) and design_reference.get("frame_screenshot"):
            reference_path = Path(str(design_reference["frame_screenshot"])).expanduser().resolve()
            results.require(reference_path.is_file(), f"Frame screenshot exists for {route}: {reference_path}")
            if reference_path.is_file() and design_reference.get("sha256"):
                results.require(
                    sha256(reference_path) == design_reference["sha256"],
                    f"Frame screenshot hash matches manifest for {route}",
                )
        elif args.require_visual:
            results.require(False, f"Frame screenshot is recorded for {route}")

        if args.require_visual and visual_report_dir is not None:
            report_path = visual_report_dir / f"{page_id}.json"
            results.require(report_path.is_file(), f"Final visual report exists for {route}: {report_path}")
            report = read_json(report_path) if report_path.is_file() else None
            results.require(report is not None, f"Final visual report is valid JSON for {route}")
            if report:
                results.require(report.get("route") == route, f"Final visual report route matches {route}")
                results.require(report.get("mode") == "frame-vs-react-final", f"Final visual report mode is frame-vs-react-final for {route}")
                results.require(report.get("status") == "pass", f"Final visual report passes for {route}")
                comparison = report.get("comparison")
                results.require(
                    isinstance(comparison, dict) and comparison.get("dimensions_match") is True,
                    f"Final screenshot dimensions match Frame for {route}",
                )
                report_reference = report.get("reference")
                expected_hash = design_reference.get("sha256") if isinstance(design_reference, dict) else None
                results.require(
                    bool(expected_hash)
                    and isinstance(report_reference, dict)
                    and report_reference.get("sha256") == expected_hash,
                    f"Final visual report uses the manifest Frame screenshot for {route}",
                )
        if path.exists():
            lines = read_text(path).count("\n") + 1
            results.warn(lines <= 120, f"Route file should remain thin ({route} has {lines} lines)")

    tsx_files = list((project / "src").rglob("*.tsx")) if (project / "src").exists() else []
    for path in tsx_files:
        text = read_text(path)
        relative = path.relative_to(project)
        results.require(not re.search(r"\bclass\s*=", text), f"No raw HTML class attribute: {relative}")
        results.require("dangerouslySetInnerHTML" not in text, f"No HTML string embedding: {relative}")
        results.require(not re.search(r"<iframe\b", text, flags=re.IGNORECASE), f"No iframe page wrapping: {relative}")
        results.warn("document.querySelector" not in text, f"Avoid DOM-query migration code: {relative}")
        results.warn('href="#"' not in text and "href='#'" not in text, f"Replace placeholder navigation: {relative}")
        results.warn('src="assets/' not in text and "src='assets/" not in text, f"Use namespaced public asset URLs: {relative}")
        if re.search(r"https?://", text) and "/api/" not in text:
            results.warnings.append(f"Review hard-coded URL in {relative}; backend hosts must be server-configured")

    print(f"PASS: {len(results.passes)}")
    for message in results.errors:
        print(f"ERROR: {message}")
    for message in results.warnings:
        print(f"WARN: {message}")
    if results.errors:
        print(f"FAILED with {len(results.errors)} error(s) and {len(results.warnings)} warning(s)")
        return 1
    print(f"OK with {len(results.warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
