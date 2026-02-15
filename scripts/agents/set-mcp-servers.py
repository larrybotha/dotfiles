#!/usr/bin/env python3

"""
Enhanced MCP server configuration script that supports multiple agent formats.
Handles unified format (Claude/Gemini) and opencode format with metadata.

Usage:
    ./set-mcp-servers.py
"""

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List


@dataclass
class ServerConfig:
    """Represents a single MCP server configuration."""

    name: str
    command: str
    args: List[str]
    metadata: Dict[str, Dict[str, Any]]


class MCPConfigManager:
    """Manages MCP server configurations for different agents."""

    def __init__(self, mcp_servers_file: Path):
        self.mcp_servers_file = mcp_servers_file
        self.config_data = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        """Load and validate the MCP servers configuration."""
        if not self.mcp_servers_file.exists():
            raise FileNotFoundError(f"{self.mcp_servers_file} not found")

        try:
            with open(self.mcp_servers_file, "r") as f:
                config_data = json.load(f)
            return self._ensure_backward_compatibility(config_data)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in {self.mcp_servers_file}: {e}")

    def _ensure_backward_compatibility(
        self, config_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Ensure configuration works with existing setups."""
        # Add defaults section if missing
        if "defaults" not in config_data:
            config_data["defaults"] = {
                "metadata": {
                    "opencode": {"type": "local", "enabled": False},
                    "claude": {"enabled": False},
                    "gemini": {"enabled": False},
                }
            }

        # Add metadata to servers that don't have it
        for server_name, server_data in config_data.get("mcpServers", {}).items():
            if "metadata" not in server_data:
                server_data["metadata"] = {}

        return config_data

    def get_server_configs(self) -> List[ServerConfig]:
        """Extract server configurations with metadata."""
        servers = []
        defaults = self.config_data.get("defaults", {}).get("metadata", {})

        for name, server_data in self.config_data.get("mcpServers", {}).items():
            # Merge server-specific metadata with defaults
            server_metadata = server_data.get("metadata", {})
            merged_metadata = self._merge_metadata(defaults, server_metadata)

            servers.append(
                ServerConfig(
                    name=name,
                    command=server_data["command"],
                    args=server_data.get("args", []),
                    metadata=merged_metadata,
                )
            )

        return servers

    def _merge_metadata(self, defaults: Dict, server_specific: Dict) -> Dict:
        """Merge default metadata with server-specific metadata."""
        merged = {}

        for agent in set(defaults.keys()) | set(server_specific.keys()):
            agent_defaults = defaults.get(agent, {})
            agent_specific = server_specific.get(agent, {})
            merged[agent] = agent_defaults | agent_specific

        return merged

    def generate_unified_config(self) -> Dict[str, Any]:
        """Generate configuration for Claude/Gemini (unified format)."""
        servers = self.get_server_configs()
        unified_servers = {}

        for server in servers:
            unified_servers[server.name] = {
                "command": server.command,
                "args": server.args,
            }

        return {"mcpServers": unified_servers}

    def generate_opencode_config(self) -> Dict[str, Any]:
        """Generate configuration for opencode (array-based commands)."""
        servers = self.get_server_configs()
        opencode_servers = {}

        for server in servers:
            opencode_metadata = server.metadata.get("opencode", {})

            opencode_servers[server.name] = {
                "type": opencode_metadata.get("type", "local"),
                "command": [server.command] + server.args,
                "enabled": opencode_metadata.get("enabled", False),
            }

        return {"mcp": opencode_servers}

    def update_config_file(
        self, config_path: Path, config_data: Dict[str, Any], /
    ) -> bool:
        """Update a specific configuration file."""
        if not config_path.exists():
            print(f"Info: Config file not found at {config_path}... skipping")
            return False

        try:
            with open(config_path, "r") as f:
                existing_config = json.load(f)
        except json.JSONDecodeError:
            print(f"Warning: Could not decode JSON from {config_path}... skipping")

            return False

        existing_config = existing_config | config_data

        try:
            with open(config_path, "w") as f:
                json.dump(existing_config, f, indent=2)
                f.write("\n")

            print(f"Successfully updated {config_path}")

            return True
        except Exception as e:
            print(f"Error writing to {config_path}: {e}", file=sys.stderr)
            return False


def main():
    """Main execution function."""
    script_dir = Path(__file__).parent
    mcp_servers_file = script_dir / "mcp-servers.json"

    try:
        manager = MCPConfigManager(mcp_servers_file)
    except (FileNotFoundError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    # Generate configurations for different agents
    unified_config = manager.generate_unified_config()
    opencode_config = manager.generate_opencode_config()

    # Define target configurations
    project_root = script_dir.parent.parent
    configs = [
        # Claude/Gemini use unified format
        (
            project_root / "home" / ".gemini" / "settings.json",
            unified_config,
            "mcpServers",
        ),
        (Path.home() / ".claude.json", unified_config, "mcpServers"),
        # opencode uses its own format
        (
            project_root / "home" / ".config" / "opencode" / "opencode.json",
            opencode_config,
            "mcp",
        ),
    ]

    # Update all configurations
    success_count = 0

    for config_path, config_data, key in configs:
        if manager.update_config_file(config_path, config_data):
            success_count += 1

    print(f"Updated {success_count}/{len(configs)} configuration files")

    return 0 if success_count > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
