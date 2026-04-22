---
name: slide-deck
description: Research a topic then build a self-contained HTML slide deck with sidebar navigation. Use when asked to create a presentation, slide deck, or interactive guide from research.
compatibility: Requires Docker
---

## Requirements

- Docker (image `pi-slide-deck-validate` built on first run)
- No Python, html5lib, or beautifulsoup4 needed on host

# Slide Deck Builder

## How

1. Research with `read`, `bash`, `grep`. Collect source URLs.
2. Plan categories, slide IDs, order. Each slide gets `id="slide-<slug>"`.
3. Copy `templates/sidebar-deck.html` as the scaffold. It has every CSS class, layout, and JS hook you need — don't reinvent any of it.
4. Write one `<div class="slide">` per topic. Nav items must have a 1:1 mapping to slide IDs.
5. Output to `{skill-dir}/tmp/{yyyy-mm-dd}-{topic-slug}.html`. Create `mkdir -p {skill-dir}/tmp` first. Resolve `{skill-dir}` from this SKILL.md's location.
6. Open in browser: `open {output-path}`.

## Content Rules

- **Description first.** Every slide opens with `<div class="description">` explaining what and why, before anything else.
- **Actionable examples.** `<div class="prompts">` for CLI commands, agent prompts, "try this" steps. Skip if topic has none.
- **Real code, no pseudocode.** `<div class="code-block">` with actual runnable TypeScript/bash/JSON. No `...` ellipsis hiding relevant code.
- **Key points grid.** `<div class="key-points">` (2-col) for the 2-4 most important takeaways per slide.
- **Feature grids only for overviews.** `<div class="feature-grid">` on title/intro slides, not per-topic slides.
- **Category tag every slide.** `<span class="ext-tag tag-<category>">`. Tags: safety, tool, command, ui, render, prompt, git, session, game, system, provider.
- **Strong highlights the noun, not the verb.** "a <strong>stateful tool</strong> that demonstrates..." not "a stateful tool that <strong>demonstrates</strong>..."
- **Source links on every slide.** `<div class="sources">` at the bottom with `<a href>` links to origin files, repos, docs, Wikipedia. No slide without at least one link.

## Negative Constraints

- No CDN, no `@import`, no external deps of any kind (including fonts). The template uses system font stacks — copy them, don't add Google Fonts.
- No light mode, no theme toggle, no responsive breakpoints below 768px.
- Don't invent new CSS custom properties. The template defines them all.
- Don't cram multiple topics into one slide.
- Don't write HTML from scratch. Copy `templates/sidebar-deck.html` and fill in content — the scaffold's `<div class="main">` wrapper, nav structure, and JS hooks must be preserved exactly.
- No misnested elements. Browsers auto-close parents on invalid nesting (e.g. `<span>` wrapping `<div>`), silently breaking DOM. Use the template's nesting patterns exactly.

## Verification

Before writing, run:

```bash
scripts/validate.sh OUTPUT.html
```

Runs in Docker — no host dependencies. Uses html5lib parser (mirrors browser DOM construction) to catch misnested elements, broken nav links, and external deps. Fix all ✗ before writing.

Editorial rules (description first, sources with links, etc.) are enforced by Content Rules above — the validator only checks structural validity.
