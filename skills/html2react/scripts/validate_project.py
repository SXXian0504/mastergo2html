#!/usr/bin/env python3
"""Validate a merged Next.js project under the default or engineering profile."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


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


def resolve_artifact_path(raw: object, project: Path, audit_path: Path) -> Path:
    path = Path(str(raw)).expanduser()
    if path.is_absolute():
        return path.resolve()
    project_path = (project / path).resolve()
    return project_path if project_path.exists() else (audit_path.parent / path).resolve()


def validate_shared_shell_audit(
    results: Results,
    audit_path: Path,
    project: Path,
    routes: list[str],
) -> None:
    results.require(audit_path.is_file(), f"Shared-shell audit exists: {audit_path}")
    if not audit_path.is_file():
        return

    audit = read_json(audit_path)
    results.require(audit is not None, f"Shared-shell audit is valid JSON: {audit_path}")
    if audit is None:
        return

    results.require(audit.get("schema_version") == 1, "Shared-shell audit schema_version is 1")
    raw_viewports = audit.get("required_viewports")
    viewports = raw_viewports if isinstance(raw_viewports, list) else []
    valid_viewports = all(isinstance(value, int) and value > 0 for value in viewports)
    results.require(bool(viewports) and valid_viewports and len(set(viewports)) == len(viewports), "Shared-shell audit has unique positive required_viewports")

    raw_limit = audit.get("max_changed_ratio")
    limit = float(raw_limit) if isinstance(raw_limit, (int, float)) else -1.0
    results.require(0 <= limit <= 0.005, "Shared-shell audit max_changed_ratio is at most 0.005")

    regions = audit.get("regions")
    results.require(isinstance(regions, dict), "Shared-shell audit has regions")
    if not isinstance(regions, dict):
        return

    route_set = set(routes)
    for region_name in ("header", "nav", "footer"):
        region = regions.get(region_name)
        results.require(isinstance(region, dict), f"Shared-shell audit covers region: {region_name}")
        if not isinstance(region, dict):
            continue
        families = region.get("families", [])
        exceptions = region.get("exceptions", [])
        results.require(isinstance(families, list), f"Shared-shell {region_name} families is a list")
        results.require(isinstance(exceptions, list), f"Shared-shell {region_name} exceptions is a list")
        if not isinstance(families, list) or not isinstance(exceptions, list):
            continue

        covered: list[str] = []
        for family_index, raw_family in enumerate(families):
            label = f"{region_name} family #{family_index + 1}"
            results.require(isinstance(raw_family, dict), f"{label} is an object")
            if not isinstance(raw_family, dict):
                continue
            family: dict[str, Any] = raw_family
            family_id = family.get("id")
            results.require(isinstance(family_id, str) and bool(family_id.strip()), f"{label} has an id")
            if isinstance(family_id, str) and family_id.strip():
                label = f"{region_name} family {family_id}"
            results.require(family.get("classification") in {"identical", "parameterized"}, f"{label} is identical or parameterized")

            component_raw = family.get("component")
            component_path = resolve_artifact_path(component_raw, project, audit_path) if component_raw else None
            component_exists = component_path is not None and component_path.is_file()
            results.require(component_exists, f"{label} shared component exists: {component_raw}")
            if component_exists and component_path is not None:
                try:
                    under_layouts = component_path.resolve().is_relative_to((project / "src/components/layouts").resolve())
                except AttributeError:
                    under_layouts = str(component_path.resolve()).startswith(str((project / "src/components/layouts").resolve()) + "/")
                results.require(under_layouts, f"{label} component is under src/components/layouts")

            component_symbol = family.get("symbol")
            if not isinstance(component_symbol, str) or not component_symbol.strip():
                component_symbol = component_path.stem if component_path and component_path.stem != "index" else component_path.parent.name if component_path else ""
            results.require(bool(component_symbol), f"{label} identifies a component symbol")

            consumers = family.get("consumers", [])
            results.require(isinstance(consumers, list) and len(consumers) >= 2, f"{label} has at least two consumers")
            family_routes: list[str] = []
            if isinstance(consumers, list):
                for consumer_index, raw_consumer in enumerate(consumers):
                    consumer_label = f"{label} consumer #{consumer_index + 1}"
                    results.require(isinstance(raw_consumer, dict), f"{consumer_label} is an object")
                    if not isinstance(raw_consumer, dict):
                        continue
                    route = raw_consumer.get("route")
                    file_raw = raw_consumer.get("file")
                    results.require(route in route_set, f"{consumer_label} uses a manifest route: {route}")
                    if isinstance(route, str):
                        family_routes.append(route)
                        covered.append(route)
                    consumer_path = resolve_artifact_path(file_raw, project, audit_path) if file_raw else None
                    consumer_exists = consumer_path is not None and consumer_path.is_file()
                    results.require(consumer_exists, f"{consumer_label} file exists: {file_raw}")
                    if consumer_exists and consumer_path is not None and component_symbol:
                        source = read_text(consumer_path)
                        results.require(
                            re.search(rf"<{re.escape(str(component_symbol))}(?:\s|/|>)", source) is not None,
                            f"{consumer_label} renders shared component {component_symbol}",
                        )
            results.require(len(family_routes) == len(set(family_routes)), f"{label} consumer routes are unique")

            reports = family.get("reports", [])
            results.require(isinstance(reports, list), f"{label} reports is a list")
            report_keys: set[tuple[str, int]] = set()
            if isinstance(reports, list):
                for report_index, raw_report in enumerate(reports):
                    report_label = f"{label} report #{report_index + 1}"
                    results.require(isinstance(raw_report, dict), f"{report_label} is an object")
                    if not isinstance(raw_report, dict):
                        continue
                    report_route = raw_report.get("route")
                    report_viewport = raw_report.get("viewport")
                    report_raw_path = raw_report.get("path")
                    results.require(report_route in family_routes, f"{report_label} belongs to a family consumer: {report_route}")
                    results.require(report_viewport in viewports, f"{report_label} uses a required viewport: {report_viewport}")
                    if isinstance(report_route, str) and isinstance(report_viewport, int):
                        report_keys.add((report_route, report_viewport))
                    report_path = resolve_artifact_path(report_raw_path, project, audit_path) if report_raw_path else None
                    report_exists = report_path is not None and report_path.is_file()
                    results.require(report_exists, f"{report_label} file exists: {report_raw_path}")
                    report = read_json(report_path) if report_exists and report_path is not None else None
                    results.require(report is not None, f"{report_label} is valid JSON")
                    if report:
                        comparison = report.get("comparison")
                        changed_ratio = comparison.get("changed_ratio") if isinstance(comparison, dict) else None
                        results.require(report.get("route") == report_route, f"{report_label} route matches")
                        results.require(report.get("mode") == "react-before-vs-react-after-shared-shell", f"{report_label} uses shared-shell comparison mode")
                        results.require(report.get("status") == "pass", f"{report_label} passes")
                        results.require(isinstance(comparison, dict) and comparison.get("dimensions_match") is True, f"{report_label} dimensions match")
                        results.require(
                            isinstance(changed_ratio, (int, float)) and changed_ratio <= limit,
                            f"{report_label} changed ratio is at most {limit}",
                        )
            expected_report_keys = {(route, viewport) for route in family_routes for viewport in viewports if isinstance(viewport, int)}
            results.require(report_keys == expected_report_keys, f"{label} has exactly one report per consumer and required viewport")

        for exception_index, raw_exception in enumerate(exceptions):
            label = f"{region_name} exception #{exception_index + 1}"
            results.require(isinstance(raw_exception, dict), f"{label} is an object")
            if not isinstance(raw_exception, dict):
                continue
            route = raw_exception.get("route")
            status = raw_exception.get("status")
            reason = raw_exception.get("reason")
            results.require(route in route_set, f"{label} uses a manifest route: {route}")
            results.require(status in {"singleton", "incompatible", "absent"}, f"{label} has a valid status")
            results.require(isinstance(reason, str) and len(reason.strip()) >= 12, f"{label} has a concrete reason")
            if isinstance(route, str):
                covered.append(route)

        results.require(set(covered) == route_set, f"Shared-shell {region_name} covers every manifest route")
        results.require(len(covered) == len(set(covered)), f"Shared-shell {region_name} covers each route exactly once")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("default", "engineering"), default="default")
    parser.add_argument("--project", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--visual-report-dir")
    parser.add_argument("--require-visual", action="store_true")
    parser.add_argument("--shared-shell-audit", help="Path to shared-shell-audit.json; defaults beside the source manifest")
    parser.add_argument("--require-shared-shell-audit", action="store_true", help="Require shared-shell audit even for a single-route project")
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
    manifest_pages = manifest.get("pages", [])
    manifest_routes = [str(page["route"]) for page in manifest_pages if isinstance(page, dict) and page.get("route")]
    shared_shell_required = args.require_shared_shell_audit or len(manifest_routes) >= 2
    shared_shell_audit_path = (
        Path(args.shared_shell_audit).expanduser().resolve()
        if args.shared_shell_audit
        else manifest_path.parent / "shared-shell-audit.json"
    )
    if shared_shell_required:
        validate_shared_shell_audit(results, shared_shell_audit_path, project, manifest_routes)
    if args.require_visual:
        results.require(visual_report_dir is not None, "Visual report directory is provided")
    package_path = project / "package.json"
    results.require(package_path.exists(), "package.json exists")
    package = json.loads(read_text(package_path)) if package_path.exists() else {}
    dependencies = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
    for dependency in ("next", "react", "react-dom", "typescript"):
        results.require(dependency in dependencies, f"Dependency declared: {dependency}")
    if args.profile == "engineering":
        for dependency in ("tailwindcss", "sass", "antd"):
            results.require(dependency in dependencies, f"Engineering dependency declared: {dependency}")
    scripts = package.get("scripts", {})
    for script in ("dev", "build", "lint", "typecheck"):
        results.require(script in scripts, f"Package script declared: {script}")

    tsconfig_path = project / "tsconfig.json"
    results.require(tsconfig_path.exists(), "tsconfig.json exists")
    tsconfig_text = read_text(tsconfig_path)
    results.require('"@/*"' in tsconfig_text and '"./src/*"' in tsconfig_text, "TypeScript alias maps @/* to src/*")

    required_paths = (
        "src/app/layout.tsx",
        "src/styles/globals.css",
        "public/design",
    )
    if args.profile == "engineering":
        required_paths += (
            "src/components/layouts",
            "src/components/in-page",
            "src/components/universal",
            "src/hooks",
            "src/utils",
            "src/types",
            "src/constants",
            "config",
        )
    for required in required_paths:
        results.require((project / required).exists(), f"Required project path exists: {required}")

    if args.profile == "engineering":
        for doc in ("ARCHITECTURE.md", "STANDARDS.md", "ROUTES.md", "DECISIONS.md"):
            results.require((project / "docs" / doc).exists(), f"Engineering document exists: docs/{doc}")

    for page in manifest_pages:
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
        results.require('href="#"' not in text and "href='#'" not in text, f"No unresolved placeholder navigation: {relative}")
        empty_source_text = re.search(
            r'<([A-Za-z][\w.]*)\b[^>]*data-text-source-node-id=["\'][^"\']+["\'][^>]*>\s*</\1>',
            text,
        )
        results.require(empty_source_text is None, f"No empty source-backed text node: {relative}")
        results.warn('src="assets/' not in text and "src='assets/" not in text, f"Use namespaced public asset URLs: {relative}")
        if re.search(r"https?://", text) and "/api/" not in text:
            results.warnings.append(f"Review hard-coded URL in {relative}; backend hosts must be server-configured")

    print(f"PROFILE: {args.profile}")
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
