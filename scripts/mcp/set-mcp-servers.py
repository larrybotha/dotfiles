#!/usr/bin/env python3

"""
This script updates the mcpServers key in the Claude and Gemini config files
with a JSON file containing the list of servers.

The JSON file should be in the following format:

{
    "mcpServers": [
        {
            "name": "Server 1",
            "url": "https://server1.com"
        },
        {
            "name": "Server 2",
            "url": "https://server2.com"
        }
    ]
}

Usage:
    ./set-mcp-servers.py
"""

import json
import sys
from pathlib import Path


def update_config_file(config_path: Path, mcp_servers_data: dict, /):
    """Reads a JSON config file, updates the mcpServers key, and saves it."""
    if not config_path.exists():
        print(f"Info: Config file not found at {config_path}... bailing")

        return

    try:
        with open(config_path, "r") as f:
            content = f.read()
            config_data = json.loads(content)
    except json.JSONDecodeError:
        print(f"Warning: Could not decode JSON from {config_path}... bailing")

        return

    config_data["mcpServers"] = mcp_servers_data["mcpServers"]

    try:
        with open(config_path, "w") as f:
            json.dump(config_data, f, indent=2)
            f.write("\n")
        print(f"Successfully updated {config_path}")
    except Exception as e:
        print(f"Error writing to {config_path}: {e}", file=sys.stderr)


def main():
    """
    Updates mcpServers in claude and gemini configs from a central JSON file.
    """
    script_dir = Path(__file__).parent
    mcp_servers_file = script_dir / "mcp-servers.json"

    if not mcp_servers_file.exists():
        print(f"Error: {mcp_servers_file} not found.", file=sys.stderr)

        return 1

    try:
        with open(mcp_servers_file, "r") as f:
            mcp_servers_data = json.load(f)
    except (json.JSONDecodeError, Exception) as e:
        print(f"Error reading or parsing {mcp_servers_file}: {e}", file=sys.stderr)

        return 1

    project_root = script_dir.parent.parent
    gemini_config_path = project_root / "home" / ".gemini" / "settings.json"
    claude_config_path = Path.home() / ".claude.json"

    [
        update_config_file(x, mcp_servers_data)
        for x in [
            gemini_config_path,
            claude_config_path,
        ]
    ]

    return 0


if __name__ == "__main__":
    sys.exit(main())
