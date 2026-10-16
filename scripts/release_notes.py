#!/usr/bin/env python3
"""Build GitHub release notes from dated sections in CHANGELOG.md."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

TAG_RE = re.compile(r"^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$")
HEADING_RE = re.compile(r"^##\s*\[(.+?)\]\s*$")
DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


@dataclass
class Section:
    heading: str
    lines: list[str] = field(default_factory=list)
    end_date: date | None = None


def tag_date(tag: str) -> date:
    match = TAG_RE.fullmatch(tag)
    if not match:
        raise ValueError(f"invalid release tag {tag!r}; expected YYYY.MM.DD or YYYY.MM.DD.N")
    try:
        return date(int(match[1]), int(match[2]), int(match[3]))
    except ValueError as error:
        raise ValueError(f"invalid date in release tag {tag!r}") from error


def sections_from(changelog: str) -> list[Section]:
    sections: list[Section] = []
    current: Section | None = None
    for line in changelog.splitlines():
        heading = HEADING_RE.match(line.strip())
        if heading:
            matches = DATE_RE.findall(heading[1])
            end_date = date(*map(int, matches[-1])) if matches else None
            current = Section(line.rstrip(), end_date=end_date)
            sections.append(current)
        elif current is not None:
            current.lines.append(line)
    return sections


def build_notes(tag: str, image: str, changelog: str, previous_tag: str | None) -> str:
    tag_date(tag)
    previous_date = tag_date(previous_tag) if previous_tag else None
    sections = sections_from(changelog)
    if not sections:
        raise ValueError("CHANGELOG.md has no dated ## [YYYY-MM-DD] sections")
    selected = (
        sections
        if previous_date is None
        else [section for section in sections if section.end_date is None or section.end_date > previous_date]
    )
    if not selected:
        selected = sections[:1]
    excerpt = "\n\n".join(
        "\n".join([section.heading, *section.lines]).rstrip() for section in selected
    )
    title = f"Changes since `{previous_tag}`" if previous_tag else "Changelog"
    return (
        f"Pull this release with Docker:\n\n```sh\ndocker pull {image}:{tag}\n```\n\n"
        f"`:{tag}` is pinned to this release; `:latest` points to the same image.\n\n"
        f"## {title}\n\n{excerpt}\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--prev-tag")
    parser.add_argument("--image", required=True)
    parser.add_argument("--changelog", default=str(Path(__file__).resolve().parents[1] / "CHANGELOG.md"))
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        notes = build_notes(args.tag, args.image, Path(args.changelog).read_text(encoding="utf-8"), args.prev_tag)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if args.output:
        Path(args.output).write_text(notes, encoding="utf-8")
    else:
        sys.stdout.write(notes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
