"""Validate slide-deck HTML using html5lib parser (mirrors browser DOM construction).

Checks:
1. Every <div class="slide"> is inside <div class="main">
2. Every nav data-slide matches a slide id
3. Zero @import / external <link>/<script> URLs

html5lib guarantees valid nesting — no separate balanced-div check needed.
"""

import re
import sys

from bs4 import BeautifulSoup


def validate(path: str) -> bool:
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()

    soup = BeautifulSoup(raw, "html5lib")
    errors: list[str] = []

    def err(msg: str) -> None:
        errors.append(msg)
        print(f"✗ {msg}")

    # 1. All slides inside <div class="main">
    slides = soup.find_all("div", class_="slide")
    main = soup.find("div", class_="main")
    if main is None:
        err("No <div class='main'> found")
        return False
    for slide in slides:
        if not slide.find_parent("div", class_="main"):
            err(f"Slide #{slide.get('id', '<no id>')} not inside <div class='main'>")

    # 2. Nav data-slide ↔ slide ids
    slide_ids = {s.get("id") for s in slides if s.get("id")}
    nav_targets = {n["data-slide"] for n in soup.find_all(attrs={"data-slide": True})}
    if missing := nav_targets - slide_ids:
        err(f"Nav data-slide with no matching slide id: {missing}")
    if orphan := slide_ids - nav_targets:
        err(f"Slide id with no matching nav item: {orphan}")

    # 3. No @import / external <link>/<script>
    external_patterns = [
        (r"@import", "CSS @import"),
        (r"<link[^>]+href=['\"]https?://", "external <link>"),
        (r"<script[^>]+src=['\"]https?://", "external <script>"),
    ]
    for pat, label in external_patterns:
        if re.search(pat, raw):
            err(f"External dependency found ({label})")

    if not errors:
        print(f"✓ All checks passed ({len(slides)} slides)")

    return not errors


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate.py <file.html>", file=sys.stderr)
        sys.exit(1)
    sys.exit(0 if validate(sys.argv[1]) else 1)
