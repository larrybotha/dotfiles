#!/usr/bin/env python3

# <xbar.title>DigitalOcean: Droplets</xbar.title>
# <xbar.version>1.0.0</xbar.version>
# <xbar.author>AI Assistant</xbar.author>
# <xbar.desc>Shows DigitalOcean droplets with their status and IP addresses. Green icon if all active, yellow if any off, red if any errors.</xbar.desc>
# <xbar.dependencies>python3</xbar.dependencies>
# <xbar.abouturl>https://www.digitalocean.com</xbar.abouturl>
# <xbar.var>string(DO_API_TOKEN): DigitalOcean API Token</xbar.var>
# <xbar.var>string(DO_API_BASE="https://api.digitalocean.com/v2"): DigitalOcean API base URL</xbar.var>
# <xbar.var>string(DO_DROPLET_NAME_FILTER=""): Filter droplets by name</xbar.var>

import json
import os
import urllib.request
from enum import Enum
from typing import NamedTuple

API_TOKEN = os.getenv("DO_API_TOKEN", "")
API_BASE = os.getenv("DO_API_BASE", "https://api.digitalocean.com/v2").rstrip("/")
NAME_FILTER = os.getenv("DO_DROPLET_NAME_FILTER", "")

MENU_SEPARATOR = "---"


class _PluginIcon(Enum):
    EMPTY_GRAY = "○ | color=gray"
    EMPTY_RED = "○ | color=red"
    FILLED_GREEN = "● | color=green"
    FILLED_YELLOW = "● | color=yellow"
    FILLED_RED = "● | color=red"


class _StatusVariant(NamedTuple):
    icon: str
    color: str


class _Status(Enum):
    ACTIVE = _StatusVariant("●", "green")
    OFF = _StatusVariant("○", "yellow")
    NEW = _StatusVariant("◐", "blue")
    ARCHIVE = _StatusVariant("□", "gray")
    ERROR = _StatusVariant("✗", "red")
    UNKNOWN = _StatusVariant("?", "gray")


def print_menu_icon(icon: _PluginIcon, /):
    print(icon.value)


def api_get(url: str, headers: dict) -> bytes:
    req = urllib.request.Request(url, headers=headers, method="GET")

    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read()


def build_url():
    return f"{API_BASE}/droplets"


def get_droplet_status(x: str, /):
    """Map droplet x to status"""
    status_lower = x.lower() if x else "unknown"
    status = _Status.UNKNOWN

    if status_lower == "active":
        status = _Status.ACTIVE
    elif status_lower == "off":
        status = _Status.OFF
    elif status_lower == "new":
        status = _Status.NEW
    elif status_lower == "archive":
        status = _Status.ARCHIVE
    elif status_lower in ["error", "failed"]:
        status = _Status.ERROR

    return status


def get_menu_icon_by_droplets(droplets: list[dict], /):
    """Determine menu icon based on droplet statuses"""
    icon = _PluginIcon.EMPTY_GRAY

    has_error = False
    has_off = False
    has_active = False

    for droplet in droplets:
        status = droplet.get("status", "").lower()

        if status in ["error", "failed"]:
            has_error = True
            break
        elif status == "off":
            has_off = True
        elif status == "active":
            has_active = True

    if has_error:
        icon = _PluginIcon.FILLED_RED
    elif has_off:
        icon = _PluginIcon.FILLED_YELLOW
    elif has_active:
        icon = _PluginIcon.FILLED_GREEN
    else:
        icon = _PluginIcon.EMPTY_GRAY

    return icon


def get_primary_ip(droplet):
    """Extract primary public IPv4 address from droplet networks"""
    networks = droplet.get("networks", {})
    v4_networks = networks.get("v4", [])

    for network in v4_networks:
        if network.get("type") == "public":
            return network.get("ip_address", "N/A")

    return "N/A"


def main():
    if not API_TOKEN:
        print_menu_icon(_PluginIcon.EMPTY_RED)
        print(MENU_SEPARATOR)
        print("Configuration required:")
        print("• Missing DO_API_TOKEN")
        return

    url = build_url()
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Content-Type": "application/json",
    }

    try:
        raw = api_get(url, headers)
        data = json.loads(raw.decode("utf-8"))

        if not isinstance(data, dict) or "droplets" not in data:
            raise ValueError("Unexpected response shape")

        droplets = sorted(data["droplets"], key=lambda x: x["name"])

        if len(NAME_FILTER) > 0:
            droplets = [
                droplet for droplet in droplets if NAME_FILTER in droplet["name"]
            ]

    except Exception as e:
        print_menu_icon(_PluginIcon.EMPTY_RED)
        print(MENU_SEPARATOR)
        print("Error fetching droplets")
        print(f"{e}")
        return

    if not droplets:
        print_menu_icon(_PluginIcon.EMPTY_GRAY)
        print(MENU_SEPARATOR)
        print("No droplets found")
        return

    # Print menu icon based on droplet statuses
    print_menu_icon(get_menu_icon_by_droplets(droplets))
    print(MENU_SEPARATOR)

    for droplet in droplets:
        name = droplet.get("name", "")
        status = droplet.get("status", "unknown")
        droplet_id = droplet.get("id", "")
        ip_address = get_primary_ip(droplet)
        size = droplet.get("size_slug", "Unknown")
        droplet_status = get_droplet_status(status)

        print(
            f"{droplet_status.value.icon} {name} | color={droplet_status.value.color}"
        )
        # Submenu with details
        if ip_address != "N/A":
            cmd = f"echo '{ip_address}' | pbcopy"
            print(
                f'--IP: {ip_address} | trim=false | terminal=false bash="/bin/bash" param1="-c" param2="{cmd}"'
            )
        else:
            print(f"--IP: {ip_address}")

        print(f"--Status: {status.upper()}")
        print(f"--Size: {size}")

        # Link to droplet in DigitalOcean console
        if droplet_id:
            print(
                f"--View in Console | href=https://cloud.digitalocean.com/droplets/{droplet_id} | color=gray"
            )

    print(MENU_SEPARATOR)
    print("Refresh | refresh=true")
    print("Open DigitalOcean Console | href=https://cloud.digitalocean.com/droplets")


if __name__ == "__main__":
    main()
