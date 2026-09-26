#!/usr/bin/env node
// Extract readable content from a URL as markdown.
// Usage: brave-content.js <url> [--json]
//
// Default: human-readable markdown on stdout.
// --json:  {"link","title","markdown"} on stdout; {"link","error"} on failure
//          (exit 0) so callers can parse failures instead of guessing.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const globalModules = "/usr/local/lib/node_modules";

const { Readability } = require(`${globalModules}/@mozilla/readability`);
const { JSDOM } = require(`${globalModules}/jsdom`);
const TurndownService = require(`${globalModules}/turndown`);
const { gfm } = require(`${globalModules}/turndown-plugin-gfm`);

const args = process.argv.slice(2);
const jsonIndex = args.indexOf("--json");
const jsonOutput = jsonIndex !== -1;
if (jsonOutput) args.splice(jsonIndex, 1);

// Note: after large console.log writes, use process.exitCode instead of
// process.exit() — process.exit() can truncate piped stdout at ~64KB (async
// flush is killed before it drains).
const url = args[0];

function htmlToMarkdown(html) {
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.use(gfm);
	turndown.addRule("removeEmptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});
	return turndown
		.turndown(html)
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/\s+\./g, ".")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extract(html) {
	const dom = new JSDOM(html, { url });
	const reader = new Readability(dom.window.document);
	const article = reader.parse();

	if (article && article.content) {
		return {
			title: article.title || "",
			markdown: htmlToMarkdown(article.content),
		};
	}

	// Fallback: strip chrome and take likely main content
	const fallbackDoc = new JSDOM(html, { url });
	const body = fallbackDoc.window.document;
	body.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el) => el.remove());

	const title = body.querySelector("title")?.textContent?.trim() || "";
	const main = body.querySelector("main, article, [role='main'], .content, #content") || body.body;
	const text = main?.innerHTML || "";

	if (text.trim().length > 100) {
		return { title, markdown: htmlToMarkdown(text) };
	}
	return null;
}

if (!url) {
	console.log("Usage: brave-content.js <url> [--json]");
	console.log("\nExtracts readable content from a webpage as markdown.");
	console.log("\nExamples:");
	console.log("  brave-content.js https://example.com/article");
	console.log("  brave-content.js https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html --json");
	process.exitCode = 1;
}

async function main() {
	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal: AbortSignal.timeout(15000),
	});

	if (!response.ok) {
		if (jsonOutput) {
			console.log(JSON.stringify({ link: url, error: `HTTP ${response.status} ${response.statusText}` }));
		} else {
			console.error(`HTTP ${response.status}: ${response.statusText}`);
			process.exitCode = 1;
		}
		return;
	}

	const html = await response.text();
	const extracted = extract(html);

	if (extracted) {
		if (jsonOutput) {
			console.log(JSON.stringify({ link: url, ...extracted }));
		} else {
			if (extracted.title) console.log(`# ${extracted.title}\n`);
			console.log(extracted.markdown);
		}
		return;
	}

	if (jsonOutput) {
		// JSON contract: failures are data (exit 0) — callers parse {link, error}
		console.log(JSON.stringify({ link: url, error: "could not extract readable content" }));
	} else {
		console.error("Could not extract readable content from this page.");
		process.exitCode = 1;
	}
}

try {
	await main();
} catch (e) {
	if (jsonOutput) {
		// JSON contract: failures are data (exit 0)
		console.log(JSON.stringify({ link: url, error: e.message }));
	} else {
		console.error(`Error: ${e.message}`);
		process.exitCode = 1;
	}
}
