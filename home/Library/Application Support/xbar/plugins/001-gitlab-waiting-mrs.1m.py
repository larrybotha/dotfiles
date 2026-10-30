#!/opt/homebrew/bin/python3
# <xbar.title>GitLab: My Review MRs</xbar.title>
# <xbar.version>2.2.0</xbar.version>
# <xbar.author>Larry Botha</xbar.author>
# <xbar.author.github>larrybotha</xbar.author.github>
# <xbar.desc>Shows open merge requests where you are a reviewer, classified by whether the ball is in your court, with the latest commit on each MR.</xbar.desc>
# <xbar.dependencies>python3</xbar.dependencies>
# <xbar.abouturl>https://gitlab.com</xbar.abouturl>
# <xbar.var>string(GITLAB_ACCESS_TOKEN): GitLab Personal Access Token (read_api)</xbar.var>
# <xbar.var>string(PROJECT_ID): GitLab project id, or namespaced group/project</xbar.var>
# <xbar.var>string(REVIEWER_ID): Your GitLab user id (integer)</xbar.var>
# <xbar.var>string(GITLAB_API_BASE="https://gitlab.com/api/v4"): GitLab API base URL (change if self-hosted)</xbar.var>

"""Menubar view of MRs awaiting your review. Single project, reviewer-scoped."""

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import namedtuple
from datetime import datetime
from enum import Enum
from logging.handlers import RotatingFileHandler
from pathlib import Path

DEFAULT_API_BASE = "https://gitlab.com/api/v4"
PER_PAGE = 20
TIMEOUT_SECONDS = 8
VERSION = "2.2.0"
USER_AGENT = f"xbar-gitlab-review-mrs/{VERSION}"
CONFLICT_STATUSES = frozenset({"cannot_be_merged", "cannot_be_merged_recheck"})
CONTEXT_INDENT = "    "

SCRIPT_DIR = Path(__file__).parent
LOG_DIR = SCRIPT_DIR / "tmp"
LOG_FILE = LOG_DIR / "gitlab-waiting-mrs.log"

COMMITS_QUERY = """
query($fullPath: ID!, $iids: [String!]) {
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: 100) {
      nodes {
        iid
        commits(first: 1) { nodes { committedDate } }
      }
    }
  }
}
"""

Config = namedtuple("Config", "token project_id reviewer_id api_base")

logger = logging.getLogger("gitlab-review-mrs")


class ReviewState(Enum):
    """MR state from the reviewer's perspective."""

    CONFLICTS = "conflicts"
    DRAFT = "draft"
    NEEDS_REVIEW = "needs_review"
    CHANGES_REQUESTED = "changes_requested"
    APPROVED = "approved"


STATE_COLOR = {
    ReviewState.CONFLICTS: "red",
    ReviewState.DRAFT: "gray",
    ReviewState.NEEDS_REVIEW: "orange",
    ReviewState.CHANGES_REQUESTED: "gray",
    ReviewState.APPROVED: "green",
}

STATE_LABEL = {
    ReviewState.CONFLICTS: "Has conflicts",
    ReviewState.DRAFT: "Draft",
    ReviewState.NEEDS_REVIEW: "Needs review",
    ReviewState.CHANGES_REQUESTED: "Changes requested",
    ReviewState.APPROVED: "Approved",
}

ICON_EMPTY = ("○", "gray")
ICON_FULL_ORANGE = ("●", "orange")
ICON_PARTIAL_ORANGE = ("◐", "orange")
ICON_FULL_GREEN = ("●", "green")
ICON_FAILURE = ("○", "red")


class FetchError(Exception):
    """Transport or API failure with menu-ready diagnostic line and action item."""

    def __init__(self, line, action):
        super().__init__(line)
        self.line = line
        self.action = action


def escape_text(value):
    """Flatten free text to one line and neutralise the xbar parameter separator."""
    if value is None:
        return ""
    return " ".join(str(value).replace("|", "│").split())


def project_key(project_id):
    """Numeric ids pass through; namespaced paths are percent-encoded."""
    return (
        project_id if project_id.isdigit() else urllib.parse.quote(project_id, safe="")
    )


def web_base(api_base):
    """Host part shared by REST, GraphQL and browser URLs."""
    return api_base.rstrip("/").removesuffix("/api/v4")


def _path_from_mrs(mrs):
    """Namespaced project path taken from any MR web URL, or None."""
    for mr in mrs:
        web_url = mr.get("web_url")
        if not isinstance(web_url, str):
            continue
        if "/-/merge_requests/" in web_url:
            path = urllib.parse.urlparse(web_url).path.strip("/")
            return path.split("/-/merge_requests/", 1)[0]
    return None


def project_web_url(mrs, api_base, project_id):
    """Canonical project web URL, or None when only a numeric id is known."""
    path = _path_from_mrs(mrs)
    if path is None:
        path = None if project_id.isdigit() else project_id
    return f"{web_base(api_base)}/{path}" if path else None


def validate_config(env):
    """Validate required configuration before any network call."""
    errors = []
    token = (env.get("GITLAB_ACCESS_TOKEN") or "").strip()
    project_id = (env.get("PROJECT_ID") or "").strip()
    reviewer_raw = (env.get("REVIEWER_ID") or "").strip()
    api_base = (
        env.get("GITLAB_API_BASE") or DEFAULT_API_BASE
    ).strip() or DEFAULT_API_BASE

    if not token:
        errors.append("Missing GITLAB_ACCESS_TOKEN")
    if not project_id:
        errors.append("Missing PROJECT_ID")

    reviewer_id = None
    if not reviewer_raw:
        errors.append("Missing REVIEWER_ID")
    else:
        try:
            reviewer_id = int(reviewer_raw)
        except ValueError:
            errors.append(f"REVIEWER_ID is not an integer: {reviewer_raw}")

    if errors:
        return None, errors
    return Config(token, project_id, reviewer_id, api_base.rstrip("/")), []


def build_url(config, iids=None, approved_by_me=False):
    """List endpoint for open MRs where config.reviewer_id is a reviewer.

    iids narrows the list to those MRs. approved_by_me additionally filters to
    MRs the reviewer currently approves; used for the second request.
    """
    params = {
        "state": "opened",
        "reviewer_id": config.reviewer_id,
        "order_by": "updated_at",
        "sort": "desc",
        "per_page": PER_PAGE,
    }
    if approved_by_me:
        params["approved_by_ids[]"] = config.reviewer_id
    if iids is not None:
        params["iids[]"] = list(iids)
    key = project_key(config.project_id)
    query = urllib.parse.urlencode(params, doseq=True)
    return f"{config.api_base}/projects/{key}/merge_requests?{query}"


def _http_error(exc, config):
    """Map an HTTPError to the failure table."""
    code = exc.code
    if code in (401, 403):
        return FetchError(
            f"GitLab auth failed (HTTP {code})",
            "Rotate the plugin token, then Refresh | refresh=true",
        )
    if code == 404:
        url = project_web_url([], config.api_base, config.project_id)
        action = f"Check PROJECT_ID | href={url}" if url else "Check PROJECT_ID"
        return FetchError(f"Project not found ({config.project_id})", action)
    if code == 429:
        retry_after = (exc.headers or {}).get("Retry-After", "").strip()
        if retry_after.isdigit():
            return FetchError(
                f"Rate limited, retry in {retry_after}s", "Refresh | refresh=true"
            )
        return FetchError("Rate limited", "Refresh | refresh=true")
    logger.debug("unmapped HTTP %s", code)
    return FetchError(f"GitLab error (HTTP {code})", "Retry | refresh=true")


def _request(config, url, payload=None):
    """One HTTP request; errors become menu-ready FetchError instances."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"PRIVATE-TOKEN": config.token, "User-Agent": USER_AGENT}
    if data is not None:
        headers["Content-Type"] = "application/json"
    logger.debug("%s %s", "POST" if data else "GET", url)
    request = urllib.request.Request(
        url, data=data, headers=headers, method="POST" if data else "GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise _http_error(exc, config) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise FetchError("GitLab unreachable", "Retry | refresh=true") from None
    logger.debug("response bytes=%d", len(raw))
    return raw


def _decode_json(raw):
    """Decode a response body; malformed JSON is a retryable FetchError."""
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise FetchError("Unexpected API response", "Retry | refresh=true") from None


def fetch(config, iids=None, approved_by_me=False):
    """Fetch one MR list. Single request, single attempt."""
    data = _decode_json(_request(config, build_url(config, iids, approved_by_me)))
    if not isinstance(data, list):
        logger.debug("unexpected payload type: %s", type(data).__name__)
        raise FetchError("Unexpected API response", "Retry | refresh=true")
    return [mr for mr in data if isinstance(mr, dict)]


def refresh(config):
    """Reviewer MRs, then the subset of those I approved (narrowed by iids)."""
    mrs = fetch(config)
    iids = [mr["iid"] for mr in mrs if mr.get("iid") is not None]
    approved = fetch(config, iids, approved_by_me=True) if iids else []
    approved_iids = {mr.get("iid") for mr in approved if mr.get("iid") is not None}
    logger.debug("approved by me: %s", sorted(approved_iids))
    return mrs, approved_iids


def graphql_url(api_base):
    """GraphQL endpoint alongside an /api/v4 base."""
    return web_base(api_base) + "/api/graphql"


def project_full_path(mrs, config):
    """Namespaced project path required by GraphQL; derived from an MR URL."""
    if not config.project_id.isdigit():
        return config.project_id
    return _path_from_mrs(mrs) or config.project_id


def parse_commit_info(payload):
    """Map iid -> {date} from the GraphQL commits response; bad nodes are skipped."""
    if not isinstance(payload, dict):
        logger.warning("commit info: non-object payload")
        return {}
    if payload.get("errors"):
        logger.warning("commit info errors: %s", payload["errors"])
    data = payload.get("data")
    project = data.get("project") if isinstance(data, dict) else None
    if not isinstance(project, dict):
        return {}
    nodes = (project.get("mergeRequests") or {}).get("nodes") or []
    info = {}
    for node in nodes:
        try:
            committed = node["commits"]["nodes"][0]["committedDate"]
            info[int(node["iid"])] = {"date": committed}
        except (TypeError, KeyError, IndexError, ValueError):
            logger.debug("skipping commit node %r", node)
    return info


def fetch_commit_info(config, mrs):
    """Latest commit per MR in one GraphQL request. Auxiliary: failures degrade."""
    iids = [str(mr["iid"]) for mr in mrs if mr.get("iid") is not None]
    if not iids:
        return {}
    payload = {
        "query": COMMITS_QUERY,
        "variables": {
            "fullPath": project_full_path(mrs, config),
            "iids": iids,
        },
    }
    try:
        raw = _request(config, graphql_url(config.api_base), payload)
        return parse_commit_info(_decode_json(raw))
    except FetchError as exc:
        logger.warning("commit info: %s", exc.line)
        return {}


def classify(mr, approved_iids=frozenset()):
    """Classify an MR. First match wins; blocking conditions outrank workflow.

    REST MR payloads carry no per-reviewer review verdict: reviewers[].state is
    the user account state ("active", "blocked"), so it is not consulted. My
    approval comes from the approved_by_ids list request; a project-wide
    requested_changes status is the only available changes-requested signal.
    """
    if mr.get("has_conflicts") or mr.get("merge_status") in CONFLICT_STATUSES:
        return ReviewState.CONFLICTS
    if mr.get("draft"):
        return ReviewState.DRAFT
    if mr.get("iid") in approved_iids:
        return ReviewState.APPROVED
    if mr.get("detailed_merge_status") == "requested_changes":
        return ReviewState.CHANGES_REQUESTED
    return ReviewState.NEEDS_REVIEW


def aggregate(states):
    """Menubar glyph and colour. Drafts excluded from every count."""
    states = list(states)
    non_draft = sum(1 for s in states if s is not ReviewState.DRAFT)
    needs = sum(1 for s in states if s is ReviewState.NEEDS_REVIEW)
    approved = sum(1 for s in states if s is ReviewState.APPROVED)

    if non_draft == 0:
        return ICON_EMPTY
    if needs > 0:
        return ICON_FULL_ORANGE if needs == non_draft else ICON_PARTIAL_ORANGE
    if approved > 0:
        return ICON_FULL_GREEN
    return ICON_EMPTY


def _fmt_time(value):
    """Local `YYYY-MM-DD HH:MM`, or None for missing/unparseable values."""
    try:
        return datetime.fromisoformat(value).astimezone().strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return None


def _updated_key(mr):
    """Sort timestamp, newest first; unparseable timestamps sort last."""
    try:
        return datetime.fromisoformat(mr.get("updated_at") or "").timestamp()
    except (TypeError, ValueError):
        return 0.0


def build_items(mrs, approved_iids=frozenset()):
    """Classify each MR; non-dict entries were already dropped by fetch."""
    return [(classify(mr, approved_iids), mr) for mr in mrs]


def sort_items(items):
    """Needs-review first, then conflicts, then the rest, newest first."""
    priority = {ReviewState.NEEDS_REVIEW: 0, ReviewState.CONFLICTS: 1}
    return sorted(
        items, key=lambda item: (priority.get(item[0], 2), -_updated_key(item[1]))
    )


def _row(prefix, text, web_url):
    """Gray, clickable row: one place for the shared xbar parameter suffix."""
    return f"{prefix}{text} | href={web_url} | color=gray | trim=false"


def _detail_lines(mr, web_url):
    """Optional detail rows, falsy values omitted."""
    lines = []

    def add(label, value):
        if value:
            lines.append(f"--{label}: {escape_text(value)} | trim=false")

    add("merge", mr.get("detailed_merge_status") or mr.get("merge_status"))
    add("draft", "true" if mr.get("draft") else "")
    add("conflicts", "true" if mr.get("has_conflicts") else "")
    add("labels", ", ".join(mr.get("labels") or []))
    notes = mr.get("user_notes_count") or 0
    add("notes", notes if notes > 0 else "")

    assignees = ", ".join(
        a.get("username", "") for a in (mr.get("assignees") or []) if a.get("username")
    )
    author = (mr.get("author") or {}).get("username")
    if assignees and assignees != author:  # author already shown as a top-level row
        lines.append(_row("--", escape_text(assignees), web_url))

    stamp = _fmt_time(mr.get("updated_at"))
    if stamp:
        lines.append(_row("--updated ", stamp, web_url))
    return lines


def _headline(mr):
    """MR number and title on the visible line."""
    ref = (mr.get("references") or {}).get("short") or f"!{mr.get('iid', '')}"
    title = escape_text(mr.get("title")) or "(no title)"
    return f"{escape_text(ref)} {title}"


def _context_lines(mr, web_url, commit_info=None):
    """Indented author, source branch and latest-code rows: top-level, not submenu."""
    lines = []
    author = (mr.get("author") or {}).get("username")
    if author:
        lines.append(_row(CONTEXT_INDENT, f"@{author}", web_url))
    branch = escape_text(mr.get("source_branch"))
    if branch:
        lines.append(_row(CONTEXT_INDENT, branch, web_url))

    if commit_info:
        stamp = _fmt_time(commit_info.get("date"))
        if stamp is None:
            logger.debug("unparseable commit date %r", commit_info.get("date"))
        lines.append(_row(CONTEXT_INDENT, f"last commit {stamp or '?'}", web_url))
    return lines


def render_item(state, mr, fallback_url, commit_info=None):
    """Menu lines for one MR: title, details submenu, author, branch, last commit."""
    web_url = mr.get("web_url") or fallback_url
    lines = [f"{_headline(mr)} | color={STATE_COLOR[state]} | href={web_url}"]
    lines.append(f"--state: {STATE_LABEL[state]} | trim=false")
    lines.extend(_detail_lines(mr, web_url))
    lines.extend(_context_lines(mr, web_url, commit_info))
    return lines


def render_menu(items, icon, project_url_value, commit_info=None, capped=False):
    """Full menu: icon, items, cap notice, footer; project link only when known."""
    glyph, color = icon
    commit_info = commit_info or {}
    out = [f"{glyph} | color={color}", "---"]
    if not items:
        out.append("No MRs awaiting your review")
    else:
        for state, mr in sort_items(items):
            out.extend(
                render_item(
                    state, mr, project_url_value, commit_info.get(mr.get("iid"))
                )
            )
        if capped:
            out.append(f"Showing newest {PER_PAGE} | trim=false")
    open_project = (
        f"Open project | href={project_url_value}"
        if project_url_value
        else "Open project"
    )
    out.extend(["---", "Refresh | refresh=true", open_project])
    return out


def render_failure(*lines):
    """Red icon, separator, then exactly the supplied diagnostic/action lines."""
    return [f"{ICON_FAILURE[0]} | color={ICON_FAILURE[1]}", "---", *lines]


def setup_logging():
    """Rotating file log; unwritable directories fall back to silent logging."""
    level = os.getenv("XBAR_GITLAB_LOG_LEVEL", "WARNING").upper()
    logger.setLevel(logging.getLevelNamesMapping().get(level, logging.WARNING))
    if logger.handlers:
        return
    logger.propagate = False
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=2)
    except OSError:
        logger.addHandler(logging.NullHandler())
        return
    handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    logger.addHandler(handler)


def main():
    """Render exactly one menu, converting any unexpected failure to a retry."""
    try:
        setup_logging()
        lines = run()
    except Exception:
        logger.exception("unhandled plugin error")
        lines = render_failure("Plugin error", "Retry | refresh=true")
    print("\n".join(lines))


def run():
    """Build the menu lines; never prints."""
    started = time.monotonic()
    config, errors = validate_config(os.environ)
    if config is None:
        logger.error("configuration invalid: %s", errors)
        return render_failure(*errors)

    try:
        mrs, approved_iids = refresh(config)
    except FetchError as exc:
        logger.error("fetch failed: %s", exc.line)
        return render_failure(exc.line, exc.action)

    items = build_items(mrs, approved_iids)
    states = [state for state, _ in items]
    icon = aggregate(states)
    commit_info = fetch_commit_info(config, mrs)
    web_url = project_web_url(mrs, config.api_base, config.project_id)
    lines = render_menu(items, icon, web_url, commit_info, capped=len(mrs) >= PER_PAGE)

    logger.info(
        "state=%s total=%d needs=%d conflicts=%d duration=%dms",
        icon[0],
        len(items),
        states.count(ReviewState.NEEDS_REVIEW),
        states.count(ReviewState.CONFLICTS),
        (time.monotonic() - started) * 1000,
    )
    return lines


if __name__ == "__main__":
    main()
