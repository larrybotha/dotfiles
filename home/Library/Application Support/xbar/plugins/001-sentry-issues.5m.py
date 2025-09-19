#!/usr/bin/env python3

# <xbar.title>Sentry: Recent Issues</xbar.title>
# <xbar.version>1.0.0</xbar.version>
# <xbar.author>AI Assistant</xbar.author>
# <xbar.desc>Shows the most recent issues in Sentry for a given project. Number of issues is configurable. Red icon if critical/high severity, yellow for medium, green for low/info.</xbar.desc>
# <xbar.dependencies>python3</xbar.dependencies>
# <xbar.abouturl>https://sentry.io</xbar.abouturl>
# <xbar.var>string(SENTRY_AUTH_TOKEN): Sentry Auth Token</xbar.var>
# <xbar.var>string(SENTRY_ORG_SLUG): Sentry Organization Slug</xbar.var>
# <xbar.var>string(SENTRY_PROJECT_SLUG): Sentry Project Slug</xbar.var>
# <xbar.var>string(SENTRY_API_BASE="https://sentry.io/api/0"): Sentry API base URL</xbar.var>
# <xbar.var>string(ISSUE_LIMIT="5"): The number of issues to show</xbar.var>

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime
from enum import Enum

AUTH_TOKEN = os.getenv("SENTRY_AUTH_TOKEN", "")
ORG_SLUG = os.getenv("SENTRY_ORG_SLUG", "")
PROJECT_SLUG = os.getenv("SENTRY_PROJECT_SLUG", "")
API_BASE = os.getenv("SENTRY_API_BASE", "https://sentry.io/api/0").rstrip("/")
ISSUE_LIMIT = os.getenv("ISSUE_LIMIT", "5")

MENU_SEPARATOR = "---"


class _Icon(Enum):
    EMPTY_GRAY = "○ | color=gray"
    EMPTY_RED = "○ | color=red"
    FILLED_GREEN = "● | color=green"
    FILLED_YELLOW = "● | color=yellow"
    FILLED_RED = "● | color=red"


def print_menu_icon(icon: _Icon, /):
    print(icon.value)


def api_get(url: str, headers: dict) -> bytes:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read()


def build_url():
    # Validate and convert limit to integer, default to 5
    try:
        limit = int(ISSUE_LIMIT)
        if limit < 1:
            limit = 5
    except (ValueError, TypeError):
        limit = 5

    base = f"{API_BASE}/projects/{ORG_SLUG}/{PROJECT_SLUG}/issues/"
    params = {
        "statsPeriod": "24h",
        "sort": "date",
        "limit": str(limit),
        "query": "is:unresolved",
    }
    return base + "?" + urllib.parse.urlencode(params)


def format_timestamp(timestamp_str):
    """Format ISO timestamp to readable format"""
    try:
        dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except:
        return timestamp_str


def get_severity_color(level):
    """Map Sentry levels to colors"""
    level_lower = level.lower() if level else "info"
    if level_lower in ["fatal", "error"]:
        return "red"
    elif level_lower == "warning":
        return "yellow"
    else:
        return "green"


def get_menu_icon_by_issues(issues):
    """Determine menu icon based on issue severity"""
    if not issues:
        return _Icon.EMPTY_GRAY

    max_severity = "info"
    for issue in issues:
        level = issue.get("level", "info").lower()
        if level in ["fatal", "error"]:
            max_severity = "error"
            break
        elif level == "warning" and max_severity != "error":
            max_severity = "warning"

    if max_severity == "error":
        return _Icon.FILLED_RED
    elif max_severity == "warning":
        return _Icon.FILLED_YELLOW
    else:
        return _Icon.FILLED_GREEN


def main():
    missing = []

    if not AUTH_TOKEN:
        missing.append("SENTRY_AUTH_TOKEN")
    if not ORG_SLUG:
        missing.append("SENTRY_ORG_SLUG")
    if not PROJECT_SLUG:
        missing.append("SENTRY_PROJECT_SLUG")

    if missing:
        print_menu_icon(_Icon.EMPTY_RED)
        print(MENU_SEPARATOR)
        print("Configuration required:")

        for key in missing:
            print(f"• Missing {key}")

        return

    url = build_url()
    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}",
        "User-Agent": "xbar-sentry-issues/1.0",
    }

    try:
        raw = api_get(url, headers)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, list):
            raise ValueError("Unexpected response shape")
    except Exception as e:
        print_menu_icon(_Icon.EMPTY_RED)
        print(MENU_SEPARATOR)
        print("Error fetching issues")
        print(f"{e}")
        return

    if not data:
        print_menu_icon(_Icon.EMPTY_GRAY)
        print(MENU_SEPARATOR)
        print("No recent issues")
        return

    # Print menu icon based on severity
    print_menu_icon(get_menu_icon_by_issues(data))
    print(MENU_SEPARATOR)

    for issue in data:
        title = issue.get("title", "(no title)").replace("\n", " ")
        level = issue.get("level", "info")
        culprit = issue.get("culprit", "Unknown")
        count = issue.get("count", 0)
        user_count = issue.get("userCount", 0)
        first_seen = issue.get("firstSeen", "")
        last_seen = issue.get("lastSeen", "")
        permalink = issue.get("permalink", "")

        color = get_severity_color(level)

        # Main title line
        print(f"{title} | color={color}")

        # Details submenu
        # Link to Sentry issue
        if permalink:
            print(f"--View in Sentry | href={permalink} | color=gray")

        print(f"--Level: {level.upper()}")
        print(f"--Culprit: {culprit}")
        print(f"--Event Count: {count}")
        print(f"--Affected Users: {user_count}")

        if first_seen:
            print(f"--First Seen: {format_timestamp(first_seen)}")
        if last_seen:
            print(f"--Last Seen: {format_timestamp(last_seen)}")

        # Additional metadata
        metadata = issue.get("metadata", {})
        if metadata:
            if "type" in metadata:
                print(f"--Error Type: {metadata['type']}")
            if "value" in metadata:
                print(f"--Error Value: {metadata['value']}")

        print("-----")

    print(MENU_SEPARATOR)
    print("Refresh | refresh=true")
    print(
        f"Open Sentry Project | href=https://sentry.io/organizations/{ORG_SLUG}/projects/{PROJECT_SLUG}/"
    )


if __name__ == "__main__":
    main()
