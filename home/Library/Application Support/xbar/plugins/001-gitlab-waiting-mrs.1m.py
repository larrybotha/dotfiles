#!/opt/homebrew/bin/python3
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


class MRReviewState(Enum):
    """MR state from reviewer perspective, ordered by priority."""

    CONFLICTS = "conflicts"  # has_conflicts=true - cannot merge
    REQUESTED_CHANGES = "requested_changes"  # reviewer requested changes
    DRAFT = "draft"  # draft=true - not ready for review
    AWAITING_APPROVAL = "awaiting_approval"  # needs approval
    APPROVED = "approved"  # approved and mergeable
    OTHER = "other"  # fallback


class _Icon(Enum):
    EMPTY_GRAY = "○ | color=gray"
    EMPTY_RED = "○ | color=red"
    FILLED_GREEN = "● | color=green"
    FILLED_ORANGE = "● | color=orange"
    FILLED_YELLOW = "● | color=yellow"
    PARTIAL_ORANGE = "◐ | color=orange"
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


def get_approval(mr_iid):
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
        approvals_by_mr_id[mr_iid] = get_approval(mr_iid)

    return approvals_by_mr_id


def classify_mr_state(mr: dict, approval: dict) -> MRReviewState:
    """Classify MR state from reviewer perspective.

    Priority order (highest to lowest):
    1. Has conflicts - informational
    2. Requested changes - YELLOW
    3. Draft - GRAY (not actionable)
    4. Awaiting approval - ORANGE
    5. Approved - GREEN
    """
    # Check conflicts first (informational only, not used for icon)
    if mr.get("has_conflicts"):
        return MRReviewState.CONFLICTS

    # Check if reviewer requested changes
    if mr.get("detailed_merge_status") == "requested_changes":
        return MRReviewState.REQUESTED_CHANGES

    # Check if draft
    if mr.get("draft"):
        return MRReviewState.DRAFT

    # Check approval status
    approved_by = approval.get("approved_by", []) if approval else []
    approvals_required = approval.get("approvals_required", 0) if approval else 0

    # Reviewer assigned but no approvals yet
    if len(approved_by) == 0:
        return MRReviewState.AWAITING_APPROVAL

    # No approval rules configured means no approval needed
    if approvals_required == 0:
        return MRReviewState.APPROVED

    if len(approved_by) >= approvals_required:
        return MRReviewState.APPROVED
    else:
        return MRReviewState.AWAITING_APPROVAL


def determine_menu_icon(merge_requests, approvals_by_mr_id):
    """Determine icon based on highest-priority MR state."""
    if not merge_requests:
        return _Icon.EMPTY_GRAY

    states = [
        classify_mr_state(mr, approvals_by_mr_id.get(mr.get("iid")))
        for mr in merge_requests
    ]

    state_counts = {}
    for s in states:
        state_counts[s] = state_counts.get(s, 0) + 1

    logger.info(f"MR states: {state_counts}")

    total = len(merge_requests)

    # Priority: requested_changes > awaiting_approval > approved
    # Draft is informational, doesn't drive icon unless all are draft

    num_requested = state_counts.get(MRReviewState.REQUESTED_CHANGES, 0)
    num_draft = state_counts.get(MRReviewState.DRAFT, 0)
    num_awaiting = state_counts.get(MRReviewState.AWAITING_APPROVAL, 0)

    # Yellow for requested changes
    if num_requested > 0:
        non_draft_total = total - num_draft
        if num_requested == non_draft_total and non_draft_total > 0:
            return _Icon.FILLED_YELLOW
        else:
            return _Icon.PARTIAL_YELLOW

    # Orange for awaiting approval (exclude drafts from calculation)
    actionable_total = total - num_draft
    if num_awaiting > 0 and actionable_total > 0:
        if num_awaiting == actionable_total:
            return _Icon.FILLED_ORANGE
        else:
            return _Icon.PARTIAL_ORANGE

    # All approved or all draft
    if num_draft == total:
        return _Icon.EMPTY_GRAY
    else:
        return _Icon.FILLED_GREEN


def escape_xbar_chars(text):
    """Escape special characters for xbar output format."""
    if not isinstance(text, str):
        return text
    return text.replace("|", "│")


# State-to-color mapping for menu items
STATE_COLOR_MAP = {
    MRReviewState.CONFLICTS: "red",
    MRReviewState.REQUESTED_CHANGES: "yellow",
    MRReviewState.DRAFT: "gray",
    MRReviewState.AWAITING_APPROVAL: "orange",
    MRReviewState.APPROVED: "green",
    MRReviewState.OTHER: "gray",
}


def get_state_label(state: MRReviewState) -> str:
    """Get human-readable label for MR state."""
    labels = {
        MRReviewState.CONFLICTS: "Has conflicts",
        MRReviewState.REQUESTED_CHANGES: "Changes requested",
        MRReviewState.DRAFT: "Draft",
        MRReviewState.AWAITING_APPROVAL: "Awaiting approval",
        MRReviewState.APPROVED: "Approved",
        MRReviewState.OTHER: "Other",
    }
    return labels.get(state, "Unknown")


def format_mr_details(mr, approval):
    """Format merge request details for display."""
    mr_iid = mr.get("iid")
    title = mr.get("title", "(no title)").replace("\n", " ")
    title = escape_xbar_chars(title)

    ref = (mr.get("references", {}) or {}).get("short") or f"!{mr.get('iid', '')}"
    url = mr.get("web_url") or "https://gitlab.com"

    assignees = ", ".join(
        [a.get("username") or "(unassigned)" for a in mr.get("assignees", [])]
    )
    assignees = escape_xbar_chars(assignees)

    # Classify state
    review_state = classify_mr_state(mr, approval)
    color = STATE_COLOR_MAP.get(review_state, "gray")

    # Build detail fields
    details = [
        ("review_state", get_state_label(review_state)),
        ("detailed_merge_status", mr.get("detailed_merge_status")),
        ("has_conflicts", mr.get("has_conflicts")),
        ("draft", mr.get("draft")),
        ("updated_at", mr.get("updated_at")),
        ("user_notes_count", mr.get("user_notes_count")),
        ("labels", mr.get("labels")),
    ]

    link_text = " - ".join([x for x in [ref, assignees] if x])

    # Approval info
    approved_by = approval.get("approved_by", []) if approval else []
    approvals_required = approval.get("approvals_required", 0) if approval else 0
    approvals_left = approval.get("approvals_left", 0) if approval else 0
    approval_info = f"{len(approved_by)}/{approvals_required} approvals"
    if approvals_left > 0:
        approval_info += f" ({approvals_left} needed)"
    details.append(("approval", approval_info))

    logger.debug(
        f"MR {mr_iid}: state={review_state.value}, color={color}, {approval_info}"
    )
    updated_at = mr.get("updated_at", "")

    return {
        "color": color,
        "details": details,
        "link_text": link_text,
        "mr_iid": mr_iid,
        "title": title,
        "updated_at": updated_at.strip(),
        "url": url,
    }


def display_merge_request(mr_data):
    """Display a single merge request in xbar format."""
    updated_at = mr_data["updated_at"]

    print(f"{mr_data['title']} | color={mr_data['color']}")

    for k, v in mr_data["details"]:
        if isinstance(v, str):
            v = escape_xbar_chars(v)
            if "\n" in v:
                vs = v.split("\n")
                v = "\n----".join(vs)

        print(f"--{k}: {v} | trim=false")

    print(f"\t{mr_data['link_text']} | trim=false | href={mr_data['url']} | color=gray")

    if updated_at:
        dt = datetime.fromisoformat(updated_at)

        print(
            f"\tupdated at {dt.strftime('%Y-%m-%d %H:%M:%S')} | trim=false | color=gray",
        )


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
    icon = determine_menu_icon(merge_requests, approvals_by_mr_id)
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
