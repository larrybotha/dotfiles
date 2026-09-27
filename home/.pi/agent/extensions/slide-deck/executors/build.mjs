#!/usr/bin/env node
/**
 * Build executor — copies templates/sidebar-deck.html, injects the deck
 * content, writes the output file. Replaces the manual agent copy step.
 *
 * In:  JSON on stdin — { title, subtitle, navHtml, slidesHtml, outPath }
 *      (deck content is large — stdin, not argv: ARG_MAX-safe)
 * Out: one-line JSON on stdout —
 *      { ok: true,  outPath, slideCount, bytes }
 *    | { ok: false, error }
 * Contract: exit 0 on both shapes (failure is data); parse/IO problems are
 * reported as ok:false, never a crash.
 *
 * Template resolved relative to this script (executors/../templates/),
 * overridable with SLIDE_DECK_TEMPLATE. Template anchors (stable contract):
 *   DECK_TITLE / DECK_SUBTITLE placeholders  — replaced everywhere
 *   <div class="nav-list" id="navList">      — navHtml inserted after
 *   <div class="main" id="mainContent">       — slidesHtml inserted after
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const out = (o) => {
	process.stdout.write(JSON.stringify(o) + "\n");
};

/** Escape plain text for HTML text content/attribute contexts. */
function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

try {
	const input = JSON.parse(readFileSync(0, "utf8"));
	const { title, subtitle, navHtml, slidesHtml, outPath } = input;
	if (!title || !subtitle || !navHtml || !slidesHtml || !outPath) {
		out({ ok: false, error: "build.mjs: missing title/subtitle/navHtml/slidesHtml/outPath" });
		process.exit(0);
	}
	const templatePath = resolve(
		process.env.SLIDE_DECK_TEMPLATE ?? resolve(here, "..", "templates", "sidebar-deck.html"),
	);

	let template;
	try {
		template = readFileSync(templatePath, "utf8");
	} catch (e) {
		out({ ok: false, error: `build.mjs: cannot read template ${templatePath}: ${e.message}` });
		process.exit(0);
	}

	// Anchor checks — a changed template is a contract break, reported up front
	const NAV_ANCHOR = '<div class="nav-list" id="navList">';
	const MAIN_ANCHOR = '<div class="main" id="mainContent">';
	if (!template.includes(NAV_ANCHOR)) {
		out({ ok: false, error: `build.mjs: template ${templatePath} missing anchor ${NAV_ANCHOR}` });
		process.exit(0);
	}
	if (!template.includes(MAIN_ANCHOR)) {
		out({ ok: false, error: `build.mjs: template ${templatePath} missing anchor ${MAIN_ANCHOR}` });
		process.exit(0);
	}

	let html = template;
	if (html.includes("DECK_TITLE")) html = html.replaceAll("DECK_TITLE", escapeHtml(title));
	else {
		out({ ok: false, error: `build.mjs: template ${templatePath} missing DECK_TITLE placeholder` });
		process.exit(0);
	}
	if (html.includes("DECK_SUBTITLE")) html = html.replaceAll("DECK_SUBTITLE", escapeHtml(subtitle));
	else {
		out({ ok: false, error: `build.mjs: template ${templatePath} missing DECK_SUBTITLE placeholder` });
		process.exit(0);
	}
	html = html.replace(NAV_ANCHOR, `${NAV_ANCHOR}\n${navHtml}`);
	html = html.replace(MAIN_ANCHOR, `${MAIN_ANCHOR}\n${slidesHtml}`);

	// Count from the submitted slides (the template's HTML-comment placeholders
// are not slides — validate.py parses with html5lib, which ignores comments)
const slideCount =
	(slidesHtml.match(/<div[^>]*class="[^"]*\bslide\b[^"]*"/g) || []).length;

	mkdirSync(dirname(resolve(outPath)), { recursive: true });
	writeFileSync(outPath, html);

	out({ ok: true, outPath: resolve(outPath), slideCount, bytes: Buffer.byteLength(html) });
} catch (e) {
	out({ ok: false, error: `build.mjs: ${e.message}` });
}
