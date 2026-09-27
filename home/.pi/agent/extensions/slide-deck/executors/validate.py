"""Validate slide-deck HTML using html5lib parser (mirrors browser DOM construction).

Structural checks (deterministic — machine-owned); editorial judgment stays
prompt-side:

1. Every <div class="slide"> is inside <div class="main">
2. Nav data-slide ↔ slide ids through the slide- prefix (bare-slug convention)
3. Zero @import / external <link>/<script> URLs
4. Duplicate slide ids / duplicate nav data-slide values
5. Every nav-item: data-slide present; onclick goToSlide('…') present; its
   argument equals data-slide (else the click targets nothing — silent breakage)
6. Per slide: description div (present, non-empty, before other content
   blocks); sources div with >= 1 link; ext-tag span
7. Tag taxonomy: every tag-* class is one the template's CSS defines (a
   curated tag has a colour; an invented one renders unstyled); every
   span.ext-tag carries exactly one tag-*
8. Unknown classes: non-fatal note — they render unstyled (the template CSS
   is the styling vocabulary), surfaced so the drift is never invisible

html5lib guarantees valid nesting — no separate balanced-div check needed.
Class checks skip elements inside <svg> (embedded mermaid output is foreign).

Exit codes: 0 valid, 1 invalid deck, 2 infra (template unreadable — the deck
was NOT checked).
"""

import os
import re
import sys

from bs4 import BeautifulSoup

TEMPLATE_PATH = os.environ.get("SLIDE_DECK_TEMPLATE_PATH", "/template/sidebar-deck.html")


def load_template():
    """Template classes (markup + CSS) and the curated tag set.

    CSS classes come from a raw regex on the <style> block: with html5lib +
    bs4, `style.get_text()` returns "" (the parser routes style content out of
    the text tree), so DOM extraction silently yields nothing.
    """
    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        raw = f.read()
    soup = BeautifulSoup(raw, "html5lib")
    classes = set()
    for el in soup.find_all(class_=True):
        classes.update(el.get("class", []))
    m = re.search(r"<style>(.*?)</style>", raw, re.DOTALL)
    if m:
        for cm in re.finditer(r"\.([a-zA-Z_][-\w]*)", m.group(1)):
            classes.add(cm.group(1))
    tags = set(re.findall(r"\.tag-([a-z]+)", m.group(1))) if m else set()
    return classes, tags


def outside_svg(el) -> bool:
    return el.find_parent("svg") is None


def validate(path: str) -> bool:
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()

    try:
        template_classes, template_tags = load_template()
    except OSError as e:
        print(f"Error: cannot read template {TEMPLATE_PATH}: {e} (infra — the deck was NOT checked)")
        sys.exit(2)

    soup = BeautifulSoup(raw, "html5lib")
    errors: list[str] = []
    notes: list[str] = []

    def err(msg: str) -> None:
        errors.append(msg)
        print(f"✗ {msg}")

    def note(msg: str) -> None:
        notes.append(msg)
        print(f"! {msg}")

    slides = soup.find_all("div", class_="slide")

    # 1. All slides inside <div class="main">
    main = soup.find("div", class_="main")
    if main is None:
        err("No <div class='main'> found")
        return False
    for slide in slides:
        if not slide.find_parent("div", class_="main"):
            err(f"Slide #{slide.get('id', '<no id>')} not inside <div class='main'>")

    # 2. Nav data-slide ↔ slide ids (bare-slug convention: the template's
    # goToSlide prefixes the id itself)
    slide_ids = [s.get("id") for s in slides if s.get("id")]
    ids_as_targets = {sid.removeprefix("slide-") for sid in slide_ids}
    nav_elements = soup.find_all(attrs={"data-slide": True})
    nav_targets = [n["data-slide"] for n in nav_elements]
    if missing := sorted(set(nav_targets) - ids_as_targets):
        err(f"Nav data-slide with no matching slide id: {missing} (data-slide holds the bare slug; ids carry the slide- prefix)")
    if orphan := sorted(ids_as_targets - set(nav_targets)):
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

    # 4. Duplicates (goToSlide / anchors only ever find the first)
    dup_ids = sorted({i for i in slide_ids if slide_ids.count(i) > 1})
    if dup_ids:
        err(f"Duplicate slide ids: {dup_ids}")
    dup_targets = sorted({t for t in nav_targets if nav_targets.count(t) > 1})
    if dup_targets:
        err(f"Duplicate nav data-slide values: {dup_targets}")

    # 5. Nav items: data-slide + matching onclick (dead-click prevention —
    # the retained corpus shipped 17 decks whose clicks silently did nothing)
    for nav in soup.find_all(class_="nav-item"):
        label = (nav.get("data-slide") or nav.get_text(strip=True) or "<nav-item>")[:60]
        if not nav.get("data-slide"):
            err(f"Nav item '{label}' has no data-slide (active-highlight tracking breaks)")
            continue
        onclick = nav.get("onclick") or ""
        m = re.search(r"goToSlide\('([^']*)'\)", onclick)
        if not m:
            err(f"Nav item '{label}' has no onclick goToSlide('slug') — the click does nothing")
        elif m.group(1) != nav["data-slide"]:
            err(f"Nav item '{label}': onclick goToSlide arg '{m.group(1)}' != data-slide '{nav['data-slide']}' (the click targets a different or missing slide)")

    # 6. Per-slide editorial-but-mechanical rules. Title-page slides (the
    # slide-title-page archetype: hero-icon + subtitle + feature-grid) are
    # exempt from description-first and the category tag — the subtitle is
    # the what+why and an overview slide carries no category; a description
    # or tag is welcome but never required there.
    CONTENT_BLOCK_CLASSES = {"description", "prompts", "key-points", "code-block", "sources", "feature-grid"}
    for slide in slides:
        sid = slide.get("id", "<no id>")
        is_title_page = "slide-title-page" in (slide.get("class", []) or [])
        desc = slide.find("div", class_="description")
        if not is_title_page:
            if desc is None or not desc.get_text(strip=True):
                err(f"Slide {sid}: missing or empty <div class='description'> (what + why, first)")
            else:
                content_blocks = [
                    c for c in slide.find_all("div", recursive=False)
                    if CONTENT_BLOCK_CLASSES & set(c.get("class", []))
                ]
                if content_blocks and "description" not in (content_blocks[0].get("class", []) or []):
                    err(f"Slide {sid}: description must come before other content blocks")
        sources = slide.find("div", class_="sources")
        links = [a for a in (sources.find_all("a", href=True) if sources else []) if a.get("href")]
        if not links:
            err(f"Slide {sid}: no <div class='sources'> with at least one <a href> link")
        if not is_title_page and slide.find("span", class_="ext-tag") is None:
            err(f"Slide {sid}: no <span class='ext-tag tag-<category>'> tag")

    # 7. Tag taxonomy (curated set = what the template CSS colours).
    # template_tags holds bare names (render, tool, …) — compare stripped.
    bad_tags = set()
    for el in soup.find_all(class_=True):
        if not outside_svg(el):
            continue
        for c in el.get("class", []):
            if c.startswith("tag-") and c.removeprefix("tag-") not in template_tags:
                bad_tags.add(c)
    if bad_tags:
        err(f"Tag categories not defined in the template CSS (they render unstyled): {sorted(bad_tags)} — known: {sorted(template_tags)}")
    for span in soup.find_all("span", class_="ext-tag"):
        if not outside_svg(span):
            continue
        tag_classes = [c for c in span.get("class", []) if c.startswith("tag-")]
        if len(tag_classes) != 1:
            err(f"ext-tag span must carry exactly one tag-* class (got {tag_classes or 'none'})")

    # 8. Unknown classes — surfaced, not fatal: the vocabulary is open, but
    # classes without CSS are invisible design drift
    unknown = set()
    for el in soup.find_all(class_=True):
        if not outside_svg(el):
            continue
        for c in el.get("class", []):
            if c not in template_classes and not c.startswith("tag-"):
                unknown.add(c)
    if unknown:
        note(f"unknown classes (no CSS in the template — they render unstyled): {', '.join(sorted(unknown))}")

    if not errors:
        print(f"✓ All checks passed ({len(slides)} slides, {len(notes)} note{'s' if len(notes) != 1 else ''})")

    return not errors


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate.py <file.html>", file=sys.stderr)
        sys.exit(1)
    sys.exit(0 if validate(sys.argv[1]) else 1)
