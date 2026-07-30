#!/usr/bin/env python3
"""Prefix ordinary CSS selectors while preserving at-rules such as keyframes/font-face."""

from __future__ import annotations

import argparse
from pathlib import Path


NO_SCOPE_AT_RULES = ("@keyframes", "@-webkit-keyframes", "@font-face", "@page", "@property", "@counter-style")
RECURSE_AT_RULES = ("@media", "@supports", "@container", "@layer", "@scope", "@starting-style")


def find_matching_brace(css: str, start: int) -> int:
    depth = 0
    quote = None
    escaped = False
    in_comment = False
    index = start
    while index < len(css):
        pair = css[index : index + 2]
        char = css[index]
        if in_comment:
            if pair == "*/":
                in_comment = False
                index += 2
                continue
            index += 1
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if pair == "/*":
            in_comment = True
            index += 2
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("Unbalanced CSS braces")


def split_selectors(selector_text: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    round_depth = square_depth = 0
    quote = None
    escaped = False
    for char in selector_text:
        if quote:
            current.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "(":
            round_depth += 1
        elif char == ")":
            round_depth -= 1
        elif char == "[":
            square_depth += 1
        elif char == "]":
            square_depth -= 1
        elif char == "," and round_depth == 0 and square_depth == 0:
            parts.append("".join(current).strip())
            current = []
            continue
        current.append(char)
    if current:
        parts.append("".join(current).strip())
    return parts


def scope_selector(selector: str, scope: str) -> str:
    stripped = selector.strip()
    if not stripped:
        return stripped
    for root in (":root", "html", "body"):
        if stripped == root:
            return scope
        if stripped.startswith(root + " ") or stripped.startswith(root + ".") or stripped.startswith(root + "#") or stripped.startswith(root + ":"):
            return scope + stripped[len(root) :]
    if stripped.startswith(scope):
        return stripped
    return f"{scope} {stripped}"


def transform(css: str, scope: str) -> str:
    output: list[str] = []
    cursor = 0
    while cursor < len(css):
        brace = css.find("{", cursor)
        if brace == -1:
            output.append(css[cursor:])
            break
        close = find_matching_brace(css, brace)
        header = css[cursor:brace]
        body = css[brace + 1 : close]
        stripped = header.strip()
        leading = header[: len(header) - len(header.lstrip())]
        trailing = header[len(header.rstrip()) :]
        if not stripped:
            output.append(css[cursor : close + 1])
        elif stripped.startswith(NO_SCOPE_AT_RULES):
            output.append(f"{header}{{{body}}}")
        elif stripped.startswith(RECURSE_AT_RULES):
            output.append(f"{header}{{{transform(body, scope)}}}")
        elif stripped.startswith("@"):
            output.append(f"{header}{{{body}}}")
        else:
            scoped = ", ".join(scope_selector(item, scope) for item in split_selectors(stripped))
            output.append(f"{leading}{scoped}{trailing}{{{body}}}")
        cursor = close + 1
    return "".join(output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scope", required=True, help="Selector such as .route-home")
    args = parser.parse_args()
    source = Path(args.input).expanduser().resolve()
    destination = Path(args.output).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(transform(source.read_text(encoding="utf-8", errors="replace"), args.scope), encoding="utf-8")
    print(f"Scoped {source} -> {destination} with {args.scope}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
