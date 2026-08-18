#!/usr/bin/env python3
"""Fail CI when private deployment data is accidentally committed."""

from __future__ import annotations

import fnmatch
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST_PATH = ROOT / ".github" / "ip-allowlist.txt"

IPV4_RE = re.compile(
    r"(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(/\d{1,2})?(?![\d.])"
)
GLOBAL_ALLOWED_IPS = {"0.0.0.0", "127.0.0.1"}
MARKDOWN_SUFFIXES = {".md", ".markdown"}


def tracked_files() -> list[Path]:
    raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [ROOT / name for name in raw.decode().split("\0") if name]


def load_allowlist() -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    if not ALLOWLIST_PATH.exists():
        return entries

    for number, raw_line in enumerate(ALLOWLIST_PATH.read_text().splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(
                f"{ALLOWLIST_PATH.relative_to(ROOT)}:{number}: "
                "expected '<path-glob>: <literal-or-*>'"
            )
        path_glob, literal = line.split(":", 1)
        path_glob = path_glob.strip()
        literal = literal.strip()
        if not path_glob or not literal:
            raise ValueError(
                f"{ALLOWLIST_PATH.relative_to(ROOT)}:{number}: "
                "allowlist path and literal must both be non-empty"
            )
        entries.append((path_glob, literal))
    return entries


def is_valid_ipv4(octets: str, cidr: str | None) -> bool:
    parts = octets.split(".")
    if any(int(part) > 255 for part in parts):
        return False
    if cidr is not None and not 0 <= int(cidr[1:]) <= 32:
        return False
    return True


def is_allowed(
    path: Path, literal: str, bare_ip: str, allowlist: list[tuple[str, str]]
) -> bool:
    if bare_ip in GLOBAL_ALLOWED_IPS:
        return True

    rel_path = path.relative_to(ROOT).as_posix()
    for path_glob, allowed_literal in allowlist:
        if not fnmatch.fnmatch(rel_path, path_glob):
            continue
        if allowed_literal == "*" or allowed_literal == literal:
            return True
    return False


def check_committed_paths(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        rel_path = path.relative_to(ROOT).as_posix()
        if rel_path in {"config.yaml", "config.yaml.bak"}:
            errors.append(f"{rel_path} must not be committed")
        if rel_path == "data" or rel_path.startswith("data/"):
            errors.append(f"{rel_path} is under data/ and must not be committed")
    return errors


def check_ipv4_literals(paths: list[Path], allowlist: list[tuple[str, str]]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        rel_path = path.relative_to(ROOT).as_posix()
        if path.suffix.lower() in MARKDOWN_SUFFIXES:
            continue
        if path == ALLOWLIST_PATH:
            continue

        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue

        for line_number, line in enumerate(text.splitlines(), 1):
            for match in IPV4_RE.finditer(line):
                bare_ip = match.group(1)
                cidr = match.group(2)
                literal = f"{bare_ip}{cidr or ''}"
                if not is_valid_ipv4(bare_ip, cidr):
                    continue
                if is_allowed(path, literal, bare_ip, allowlist):
                    continue
                errors.append(
                    f"{rel_path}:{line_number}: hardcoded IPv4 literal {literal}"
                )
    return errors


def main() -> int:
    try:
        allowlist = load_allowlist()
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1

    paths = tracked_files()
    errors = check_committed_paths(paths)
    errors.extend(check_ipv4_literals(paths, allowlist))

    if not errors:
        print("Leak check passed.")
        return 0

    print("Leak check failed:")
    for error in errors:
        print(f"- {error}")
    print(
        "\nIf an IPv4 literal is intentional, add a narrow entry to "
        ".github/ip-allowlist.txt instead of weakening the pattern."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
