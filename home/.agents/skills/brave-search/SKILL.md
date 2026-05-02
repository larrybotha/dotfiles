---
name: brave-search
description: "Web search and content extraction via Brave Search API. All execution runs in Docker — no host dependencies required beyond Docker. API key managed by pass."
---

# Brave Search

Web search and content extraction using the Brave Search API. All execution runs inside a Docker container — no Node.js or npm needed on host. API key retrieved from `pass` at runtime only.

## Setup

1. Create a Brave Search API account at https://api-dashboard.search.brave.com/register
2. Create a "Free AI" subscription (credit card required, won't be charged)
3. Create an API key for the subscription
4. Store the key in pass:
   ```bash
   pass insert brave-search/api-key/pi
   ```
5. Build the Docker image on first run (automatic)

## Search

```bash
{baseDir}/scripts/search.sh "query"                         # Basic search (5 results)
{baseDir}/scripts/search.sh "query" -n 10                   # More results (max 20)
{baseDir}/scripts/search.sh "query" --content               # Include page content as markdown
{baseDir}/scripts/search.sh "query" --freshness pw          # Results from last week
{baseDir}/scripts/search.sh "query" --freshness 2024-01-01to2024-06-30  # Date range
{baseDir}/scripts/search.sh "query" --country DE            # Results from Germany
{baseDir}/scripts/search.sh "query" -n 3 --content         # Combined options
```

### Options

- `-n <num>` - Number of results (default: 5, max: 20)
- `--content` - Fetch and include page content as markdown
- `--country <code>` - Two-letter country code (default: US)
- `--freshness <period>` - Filter by time:
  - `pd` - Past day (24 hours)
  - `pw` - Past week
  - `pm` - Past month
  - `py` - Past year
  - `YYYY-MM-DDtoYYYY-MM-DD` - Custom date range

## Extract Page Content

```bash
{baseDir}/scripts/content.sh https://example.com/article
```

Fetches a URL and extracts readable content as markdown.

## Output Format

```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Age: 2 days ago
Snippet: Description from search results
Content: (if --content flag used)
  Markdown content extracted from the page...

--- Result 2 ---
...
```

## When to Use

- Searching for documentation or API references
- Looking up facts or current information
- Fetching content from specific URLs
- Any task requiring web search without interactive browsing

## Requirements

- Docker (image `pi-brave-search` built on first run)
- `pass` with key at `brave-search/api-key/pi`
