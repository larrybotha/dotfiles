#!/usr/bin/env python3
# <xbar.title>GitLab: My Review MRs</xbar.title>
# <xbar.version>1.0.1</xbar.version>
# <xbar.author>Larry Botha</xbar.author>
# <xbar.author.github>larrybotha</xbar.author.github>
# <xbar.desc>Shows your currently assigned GitLab merge requests (as reviewer). Green icon if any, plain white circle if none.</xbar.desc>
# <xbar.dependencies>python3, pass</xbar.dependencies>
# <xbar.abouturl>https://gitlab.com</xbar.abouturl>
# <xbar.var>string(GITLAB_ACCESS_TOKEN): GitLab Personal Access Token</xbar.var>
# <xbar.var>string(PROJECT_ID): GitLab Project ID</xbar.var>
# <xbar.var>string(REVIEWER_ID): Your GitLab User ID (reviewer)</xbar.var>
# <xbar.var>string(GITLAB_API_BASE="https://gitlab.com/api/v4"): GitLab API base URL (change if self-hosted)</xbar.var>

import json
import os
import urllib.parse
import urllib.request
from enum import Enum

ACCESS_TOKEN = os.getenv("GITLAB_ACCESS_TOKEN", "")
PROJECT_ID = os.getenv("PROJECT_ID", "")
REVIEWER_ID = os.getenv("REVIEWER_ID", "")
API_BASE = os.getenv("GITLAB_API_BASE", "https://gitlab.com/api/v4").rstrip("/")

MENU_SEPARATOR = "---"


class _Icon(Enum):
    GREEN = "🟢"
    YELLOW = "🟡"
    WHITE = "⚪"


def print_menu_icon(icon: _Icon, /):
    print(icon.value)


def api_get(url: str, headers: dict) -> bytes:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read()


def build_url():
    base = f"{API_BASE}/projects/{PROJECT_ID}/merge_requests"
    params = {
        "order_by": "updated_at",
        "per_page": "50",
        "reviewer_id": REVIEWER_ID,
        "sort": "desc",
        "state": "opened",
    }
    return base + "?" + urllib.parse.urlencode(params)


def get_approval_status(project_id, mr_iid, token):
    url = f"{API_BASE}/projects/{PROJECT_ID}/merge_requests/{mr_iid}/approvals"
    headers = {
        "PRIVATE-TOKEN": ACCESS_TOKEN,
        "User-Agent": "xbar-gitlab-review-mrs/1.0",
    }

    try:
        raw = api_get(url, headers)
        data = json.loads(raw.decode("utf-8"))

        return data.get("user_has_approvd", False)
    except Exception:
        return False


def main():
    missing = []

    if not ACCESS_TOKEN:
        missing.append("ACCESS_TOKEN (or failed to retrieve token with pass)")
    if not PROJECT_ID:
        missing.append("PROJECT_ID")
    if not REVIEWER_ID:
        missing.append("REVIEWER_ID")
    if missing:
        print_menu_icon(_Icon.WHITE)
        print(MENU_SEPARATOR)
        print("Configuration required:")
        for key in missing:
            print(f"• Missing {key}")
        return

    url = build_url()
    headers = {
        "PRIVATE-TOKEN": ACCESS_TOKEN,
        "User-Agent": "xbar-gitlab-review-mrs/1.0",
    }

    try:
        raw = api_get(url, headers)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, list):
            raise ValueError("Unexpected response shape")
    except Exception as e:
        print_menu_icon(_Icon.WHITE)
        print(MENU_SEPARATOR)
        print("Error fetching merge requests")
        print(f"{e}")

        return

    approvals = []

    for mr in data:
        approvals.append(
            get_approval_status(
                mr.get("project_id"),
                mr.get("iid"),
                ACCESS_TOKEN,
            )
        )

    print_menu_icon(_Icon.GREEN if all(approvals) else _Icon.YELLOW)
    print(MENU_SEPARATOR)

    for mr in data:
        title = mr.get("title", "(no title)").replace("\n", " ")
        ref = (mr.get("references", {}) or {}).get("short") or f"!{mr.get('iid', '')}"
        url = mr.get("web_url") or "https://gitlab.com"
        assignees = ", ".join([a.get("username", "?") for a in mr.get("assignees", [])])
        keys = [
            "detailed_merge_status",
            "description",
            "has_conflicts",
            "updated_at",
            "user_notes_count",
            "labels",
            "merge_status",
        ]
        details = [(k, mr.get(k)) for k in keys]
        link_text = " - ".join([x for x in [ref, assignees] if x])

        print(title)

        for k, v in details:
            if isinstance(v, str) and "\n" in v:
                vs = v.split("\n")
                v = "\n----".join(vs)

            print(f"--{k}: {v} | trim=false")

        print(f"\t{link_text} | trim=false | href={url} | color=gray")

    print(MENU_SEPARATOR)
    print("Refresh | refresh=true")


if __name__ == "__main__":
    main()
