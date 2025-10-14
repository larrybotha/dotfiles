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
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime
from enum import Enum
from pathlib import Path

ACCESS_TOKEN = os.getenv("GITLAB_ACCESS_TOKEN", "")
PROJECT_ID = os.getenv("PROJECT_ID", "")
REVIEWER_ID = os.getenv("REVIEWER_ID", "")
API_BASE = os.getenv("GITLAB_API_BASE", "https://gitlab.com/api/v4").rstrip("/")

MENU_SEPARATOR = "---"

# Setup logging
SCRIPT_DIR = Path(__file__).parent
LOG_DIR = SCRIPT_DIR / "tmp"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "gitlab-waiting-mrs.log"

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
    ],
)
logger = logging.getLogger(__name__)


class _Icon(Enum):
    EMPTY_GRAY = "○ | color=gray"
    EMPTY_RED = "○ | color=red"
    FILLED_GREEN = "● | color=green"
    FILLED_YELLOW = "● | color=yellow"
    PARTIAL_YELLOW = "◐ | color=yellow"


def print_menu_icon(icon: _Icon, /):
    print(icon.value)


def api_get(url: str, headers: dict) -> bytes:
    logger.debug(f"API GET request to: {url}")
    req = urllib.request.Request(url, headers=headers, method="GET")

    with urllib.request.urlopen(req, timeout=10) as resp:
        data = resp.read()
        logger.debug(f"API response length: {len(data)} bytes")

        return data


def build_url():
    base = f"{API_BASE}/projects/{PROJECT_ID}/merge_requests"
    params = {
        "order_by": "updated_at",
        "per_page": "10",
        "reviewer_id": REVIEWER_ID,
        "sort": "desc",
        "state": "opened",
    }

    return base + "?" + urllib.parse.urlencode(params)


def get_approval(project_id, mr_iid, token):
    url = f"{API_BASE}/projects/{PROJECT_ID}/merge_requests/{mr_iid}/approvals"
    headers = {
        "PRIVATE-TOKEN": ACCESS_TOKEN,
        "User-Agent": "xbar-gitlab-review-mrs/1.0",
    }

    try:
        logger.debug(f"Fetching approval for MR {mr_iid}")
        raw = api_get(url, headers)
        data = json.loads(raw.decode("utf-8"))
        logger.debug(f"Approval data for MR {mr_iid}: {data}")

        return data
    except Exception as e:
        logger.error(f"Error fetching approval for MR {mr_iid}: {e}")

        return {}


def validate_configuration():
    """Validate required configuration and display errors if missing."""
    logger.info("=" * 50)
    logger.info(f"Script started at {datetime.now()}")
    logger.debug(f"API_BASE: {API_BASE}")
    logger.debug(f"PROJECT_ID: {PROJECT_ID}")
    logger.debug(f"REVIEWER_ID: {REVIEWER_ID}")
    logger.debug(f"ACCESS_TOKEN present: {bool(ACCESS_TOKEN)}")

    missing = []

    if not ACCESS_TOKEN:
        missing.append("ACCESS_TOKEN (or failed to retrieve token with pass)")
    if not PROJECT_ID:
        missing.append("PROJECT_ID")
    if not REVIEWER_ID:
        missing.append("REVIEWER_ID")

    if missing:
        logger.error(f"Missing configuration: {missing}")
        print_menu_icon(_Icon.EMPTY_RED)
        print(MENU_SEPARATOR)
        print("Configuration required:")
        for key in missing:
            print(f"• Missing {key}")
        return False

    return True


def fetch_merge_requests():
    """Fetch merge requests from GitLab API."""
    url = build_url()
    logger.debug(f"Built URL: {url}")
    headers = {
        "PRIVATE-TOKEN": ACCESS_TOKEN,
        "User-Agent": "xbar-gitlab-review-mrs/1.0",
    }

    try:
        logger.info("Fetching merge requests...")
        raw = api_get(url, headers)
        data = json.loads(raw.decode("utf-8"))
        logger.info(
            f"Received {len(data) if isinstance(data, list) else 'non-list'} merge requests"
        )
        if not isinstance(data, list):
            logger.error(f"Unexpected response shape: {type(data)}")
            raise ValueError("Unexpected response shape")
        return data
    except Exception as e:
        logger.error(f"Error fetching merge requests: {e}", exc_info=True)
        print_menu_icon(_Icon.EMPTY_RED)
        print(MENU_SEPARATOR)
        print("Error fetching merge requests")
        print(f"{e}")
        return None


def fetch_all_approvals(merge_requests):
    """Fetch approval status for all merge requests."""
    logger.info(f"Processing {len(merge_requests)} merge requests")
    approvals_by_mr_id = {}

    for mr in merge_requests:
        mr_iid = mr.get("iid")
        logger.debug(f"Processing MR: {mr_iid} - {mr.get('title', 'No title')}")
        approvals_by_mr_id[mr_iid] = get_approval(
            mr.get("project_id"),
            mr_iid,
            ACCESS_TOKEN,
        )

    return approvals_by_mr_id


def determine_menu_icon(approvals_by_mr_id, total_mrs):
    """Determine which icon to display based on approval status."""
    num_unapproved = len(
        [v for v in approvals_by_mr_id.values() if len(v.get("approved_by", [])) == 0]
    )
    logger.info(f"Unapproved MRs: {num_unapproved}/{total_mrs}")

    if num_unapproved == total_mrs:
        logger.debug("All MRs unapproved - showing FILLED_YELLOW")
        return _Icon.FILLED_YELLOW
    elif num_unapproved > 0:
        logger.debug("Some MRs unapproved - showing PARTIAL_YELLOW")
        return _Icon.PARTIAL_YELLOW
    else:
        logger.debug("All MRs approved - showing FILLED_GREEN")
        return _Icon.FILLED_GREEN


def escape_xbar_chars(text):
    """Escape special characters for xbar output format."""
    if not isinstance(text, str):
        return text
    return text.replace("|", "│")


def format_mr_details(mr, approval):
    """Format merge request details for display."""
    mr_iid = mr.get("iid")
    title = mr.get("title", "(no title)").replace("\n", " ")
    title = escape_xbar_chars(title)

    ref = (mr.get("references", {}) or {}).get("short") or f"!{mr.get('iid', '')}"
    url = mr.get("web_url") or "https://gitlab.com"

    assignees = ", ".join([a.get("username", "?") for a in mr.get("assignees", [])])
    assignees = escape_xbar_chars(assignees)

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

    approved_count = len(approval.get("approved_by") or []) if approval else 0
    color = "green" if approved_count > 0 else "yellow"

    logger.debug(f"Displaying MR {mr_iid}: approved={approved_count}, color={color}")

    return {
        "title": title,
        "color": color,
        "details": details,
        "link_text": link_text,
        "url": url,
        "mr_iid": mr_iid,
    }


def display_merge_request(mr_data):
    """Display a single merge request in xbar format."""
    print(f"{mr_data['title']} | color={mr_data['color']}")

    for k, v in mr_data["details"]:
        if isinstance(v, str):
            v = escape_xbar_chars(v)
            if "\n" in v:
                vs = v.split("\n")
                v = "\n----".join(vs)

        print(f"--{k}: {v} | trim=false")

    print(f"\t{mr_data['link_text']} | trim=false | href={mr_data['url']} | color=gray")


def display_merge_requests(merge_requests, approvals_by_mr_id):
    """Display all merge requests in the menu."""
    for mr in merge_requests:
        mr_iid = mr.get("iid")
        approval = approvals_by_mr_id.get(mr_iid)
        mr_data = format_mr_details(mr, approval)
        display_merge_request(mr_data)


def main():
    """Main entry point for the xbar plugin."""
    # Validate configuration
    if not validate_configuration():
        return

    # Fetch merge requests
    merge_requests = fetch_merge_requests()
    if merge_requests is None:
        return

    # Handle empty results
    if not merge_requests:
        logger.info("No merge requests found")
        print_menu_icon(_Icon.EMPTY_GRAY)
        print(MENU_SEPARATOR)
        print("No merge pending merge requests")
        return

    # Fetch approvals for all MRs
    approvals_by_mr_id = fetch_all_approvals(merge_requests)

    # Determine and display menu icon
    icon = determine_menu_icon(approvals_by_mr_id, len(merge_requests))
    print_menu_icon(icon)

    # Display menu items
    print(MENU_SEPARATOR)
    display_merge_requests(merge_requests, approvals_by_mr_id)

    # Display footer
    print(MENU_SEPARATOR)
    print("Refresh | refresh=true")
    logger.info("Script completed successfully")


if __name__ == "__main__":
    main()
