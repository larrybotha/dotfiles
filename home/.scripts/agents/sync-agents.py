#!/usr/bin/env python3

"""
Agent and command configuration synchronization script.
Generates provider-specific configurations from unified templates.

Requirements:
    - PyYAML (managed via uv: uv add pyyaml)

Usage:
    uv run python sync-agents.py [--config CONFIG_FILE]
"""

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import yaml


@dataclass
class TemplateConfig:
    """Represents a parsed template with metadata."""

    type: str  # 'agent' or 'command'
    body: str
    shared_config: Dict[str, Any]
    provider_metadata: Dict[str, Dict[str, Any]]


@dataclass
class MCPServerConfig:
    """Represents a single MCP server configuration."""

    name: str
    command: str
    args: List[str]
    providers: Dict[str, Dict[str, Any]]  # provider -> {enabled: bool, ...metadata}


class FrontmatterParser:
    """Parses YAML frontmatter from markdown files."""

    @staticmethod
    def parse_file(template_path: Path) -> TemplateConfig:
        """Parse a template file into a TemplateConfig object."""
        content = template_path.read_text()

        # Split frontmatter and body
        parts = re.split(r"^---\s*$", content, maxsplit=2, flags=re.MULTILINE)
        if len(parts) < 3:
            raise ValueError(f"No valid frontmatter in {template_path}")

        frontmatter_yaml = parts[1]
        body = parts[2].strip()

        # Parse YAML
        try:
            frontmatter = yaml.safe_load(frontmatter_yaml)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML in {template_path}: {e}")

        return TemplateConfig(
            type=frontmatter["type"],
            body=body,
            shared_config=frontmatter.get("shared", {}) or {},
            provider_metadata={
                "claude": frontmatter.get("claude", {}) or {},
                "opencode": frontmatter.get("opencode", {}) or {},
            },
        )


class MCPGenerator:
    """Generates MCP configuration files for different providers."""

    @staticmethod
    def generate_claude_format(servers: List[MCPServerConfig]) -> Dict[str, Any]:
        """Generate Claude format: {"mcpServers": {...}}"""
        mcp_servers = {}
        for server in servers:
            provider_config = server.providers.get("claude", {})
            if provider_config.get("enabled", False):
                mcp_servers[server.name] = {
                    "command": server.command,
                    "args": server.args,
                }
        return {"mcpServers": mcp_servers}

    @staticmethod
    def generate_gemini_format(servers: List[MCPServerConfig]) -> Dict[str, Any]:
        """Generate Gemini format (same as Claude)."""
        mcp_servers = {}
        for server in servers:
            provider_config = server.providers.get("gemini", {})
            if provider_config.get("enabled", False):
                mcp_servers[server.name] = {
                    "command": server.command,
                    "args": server.args,
                }
        return {"mcpServers": mcp_servers}

    @staticmethod
    def generate_opencode_format(servers: List[MCPServerConfig]) -> Dict[str, Any]:
        """Generate OpenCode format: {"mcp": {...}}"""
        mcp = {}
        for server in servers:
            provider_config = server.providers.get("opencode", {})
            if provider_config.get("enabled", False):
                mcp[server.name] = {
                    "type": provider_config.get("type", "local"),
                    "command": [server.command] + server.args,
                    "enabled": True,
                }
        return {"mcp": mcp}


class TemplateGenerator:
    """Generates template files for all providers using unified format."""

    @staticmethod
    def generate_frontmatter(template: TemplateConfig, provider: str) -> str:
        """Generate provider-specific YAML frontmatter."""
        # Merge shared config with provider config (provider values override)
        config = template.shared_config | template.provider_metadata.get(provider, {})

        # Remove 'enabled' field - not part of frontmatter
        config = {k: v for k, v in config.items() if k != "enabled"}

        # Output as YAML - field order follows natural dict merge order
        # (shared fields first, then provider-specific fields)
        return yaml.dump(
            config,
            default_flow_style=False,
            sort_keys=False,
            width=float("inf"),
            allow_unicode=True,
        )

    @staticmethod
    def generate_file_content(template: TemplateConfig, provider: str) -> str:
        """Generate complete provider-format file."""
        frontmatter = TemplateGenerator.generate_frontmatter(template, provider)
        return f"---\n{frontmatter}---\n\n{template.body}\n"


class AgentSyncManager:
    """Manages the synchronization of agent and command templates."""

    def __init__(self, templates_dir: Path, config_file: Path):
        self.templates_dir = templates_dir
        self.config = self._load_config(config_file)
        self.generator = TemplateGenerator

    def _load_config(self, config_file: Path) -> Dict[str, Any]:
        """Load provider configuration from YAML file."""
        if not config_file.exists():
            raise FileNotFoundError(f"Config file not found: {config_file}")

        with open(config_file, "r") as f:
            return yaml.safe_load(f)

    def discover_templates(self) -> List[Path]:
        """Find all template markdown files."""
        return sorted(self.templates_dir.rglob("*.md"))

    def get_output_path(
        self, template_path: Path, provider: str, template_type: str, config: Dict
    ) -> Path:
        """Calculate output path for a generated file."""
        # Get relative path from templates/{type}s/ directory
        type_dir = self.templates_dir / (template_type + "s")
        rel_path = template_path.relative_to(type_dir)

        # Provider base paths from config
        provider_config = config["providers"][provider]
        templates_dir = provider_config.get("templates_dir")
        if not templates_dir:
            raise ValueError(f"No templates_dir configured for provider: {provider}")
        provider_base = Path(templates_dir).expanduser()

        # Provider-specific subdirectory names
        dirs_by_provider = {
            "claude": {
                "agent": "agents",
                "command": "commands",
            },
            "opencode": {
                "agent": "agent",
                "command": "command",
            },
        }

        # Build full path: base / subdir / relative_path
        subdir = dirs_by_provider[provider][template_type]
        base_dir = provider_base / subdir
        return base_dir / rel_path

    def write_generated_file(self, output_path: Path, content: str) -> bool:
        """Write generated content to output file."""
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            output_path.write_text(content)
            print(f"Generated: {output_path}")

            return True
        except Exception as e:
            print(f"Error writing {output_path}: {e}", file=sys.stderr)

            return False

    def _deep_merge_mcp_servers(
        self, existing: Dict[str, Any], new: Dict[str, Any], mcp_key: str
    ) -> Dict[str, Any]:
        """
        Deep merge MCP server configurations, preserving existing servers.

        Args:
            existing: Existing configuration dictionary
            new: New configuration dictionary
            mcp_key: Key for MCP servers ('mcpServers' or 'mcp')

        Returns:
            Merged configuration dictionary
        """
        # Start with shallow copy of existing config
        result = existing.copy()

        # Deep merge the MCP servers section
        if mcp_key in new:
            if mcp_key not in result:
                # No existing MCP servers, just add new ones
                result[mcp_key] = new[mcp_key]
            else:
                # Server-level deep merge: preserve existing servers and their fields
                result[mcp_key] = existing[mcp_key].copy()
                for server_name, server_config in new[mcp_key].items():
                    if server_name in result[mcp_key]:
                        # Deep merge individual server config (preserves env, custom fields)
                        result[mcp_key][server_name] = (
                            result[mcp_key][server_name] | server_config
                        )
                    else:
                        # New server, just add it
                        result[mcp_key][server_name] = server_config

        # Add any other top-level keys from new config
        for key, value in new.items():
            if key != mcp_key:
                result[key] = value

        return result

    def merge_json_file(self, target_path: Path, new_data: Dict[str, Any]) -> bool:
        """
        Merge new configuration data into existing JSON file.

        Args:
            target_path: Path to target JSON file
            new_data: New configuration data to merge

        Returns:
            True if successful, False otherwise
        """
        # Create parent directory if needed
        target_path.parent.mkdir(parents=True, exist_ok=True)

        # Create timestamped backup of existing file
        if target_path.exists():
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = target_path.with_suffix(f".backup.{timestamp}")
            try:
                shutil.copy2(target_path, backup_path)
                print(f"Created backup: {backup_path}")
            except Exception as e:
                print(
                    f"Warning: Could not create backup: {e}", file=sys.stderr
                )  # Backup is optional

        # Load existing config or start with empty dict
        existing_config = {}
        if target_path.exists():
            try:
                existing_config = json.loads(target_path.read_text())
            except json.JSONDecodeError as e:
                print(f"Warning: Could not parse {target_path}: {e}", file=sys.stderr)
                print(f"Creating new file at {target_path}", file=sys.stderr)

        # Determine MCP key, preferring existing file's format for consistency
        if existing_config:
            mcp_key = "mcpServers" if "mcpServers" in existing_config else "mcp"
        else:
            mcp_key = "mcpServers" if "mcpServers" in new_data else "mcp"

        # Normalize existing config to use consistent key (prevent dual-key configs)
        if existing_config and mcp_key == "mcpServers" and "mcp" in existing_config:
            # Migrate old "mcp" to "mcpServers"
            existing_config["mcpServers"] = existing_config.pop("mcp")
        elif existing_config and mcp_key == "mcp" and "mcpServers" in existing_config:
            # Migrate old "mcpServers" to "mcp"
            existing_config["mcp"] = existing_config.pop("mcpServers")

        # Deep merge MCP servers to preserve existing servers
        merged_config = self._deep_merge_mcp_servers(existing_config, new_data, mcp_key)

        # Write merged config atomically using temp file
        temp_path = target_path.with_suffix(target_path.suffix + ".tmp")
        try:
            temp_path.write_text(json.dumps(merged_config, indent=2) + "\n")
            # Atomic rename
            temp_path.replace(target_path)
            print(f"Updated MCP config: {target_path}")
            return True
        except Exception as e:
            print(f"Error writing {target_path}: {e}", file=sys.stderr)
            # Clean up temp file if it exists
            if temp_path.exists():
                temp_path.unlink()
            return False

    def validate_template(
        self, template: TemplateConfig, template_path: Path
    ) -> List[str]:
        """Validate template configuration and return warnings."""
        warnings = []

        # Warn if no providers are enabled
        enabled_providers = [
            p
            for p, cfg in template.provider_metadata.items()
            if cfg.get("enabled", False)
        ]

        if not enabled_providers:
            warnings.append(
                f"{template_path.name}: No providers enabled. "
                f"This template will not generate any files."
            )

        return warnings

    def load_mcp_servers(
        self, global_config_path: Path, project_config_path: Path | None
    ) -> List[MCPServerConfig]:
        """
        Load and merge global and project MCP servers.

        Args:
            global_config_path: Path to global config.yml (~/.scripts/agents/config.yml)
            project_config_path: Path to project config.yml (./config.yml) or None

        Returns:
            List of merged MCPServerConfig objects
        """
        # Load global config
        global_config = self._load_config(global_config_path)
        global_servers = global_config.get("mcp_servers", {})

        # Load project config if it exists
        project_servers = {}
        if project_config_path and project_config_path.exists():
            try:
                project_config = self._load_config(project_config_path)
                project_servers = project_config.get("mcp_servers", {})
            except Exception as e:
                print(f"Warning: Could not load project config: {e}")

        # Merge: global first, then project overrides
        merged = {}

        # Add all global servers
        for name, server_data in global_servers.items():
            merged[name] = MCPServerConfig(
                name=name,
                command=server_data["command"],
                args=server_data.get("args", []),
                providers=server_data.get("providers", {}),
            )

        # Merge/override with project servers
        for name, server_data in project_servers.items():
            merged[name] = MCPServerConfig(
                name=name,
                command=server_data.get(
                    "command", merged.get(name, MCPServerConfig("", "", [], {})).command
                ),
                args=server_data.get(
                    "args", merged.get(name, MCPServerConfig("", "", [], {})).args
                ),
                providers=server_data.get("providers", {}),
            )

        return list(merged.values())

    def sync_mcp_servers(self, global_config_path: Path) -> int:
        """
        Synchronize MCP server configurations to provider files.

        Returns:
            Number of successfully updated files
        """
        # Determine project config path (current directory)
        project_config_path = Path.cwd() / "config.yml"

        # Load and merge servers
        servers = self.load_mcp_servers(global_config_path, project_config_path)

        if not servers:
            print("No MCP servers configured")
            return 0

        # Validate that all enabled providers have mcp_config paths
        validation_errors = []
        available_providers = self.config.get("providers", {})

        for server in servers:
            for provider_name, provider_config in server.providers.items():
                if provider_config.get("enabled", False):
                    # Check if provider exists in config
                    if provider_name not in available_providers:
                        validation_errors.append(
                            f"MCP server '{server.name}' is enabled for provider '{provider_name}', "
                            f"but provider '{provider_name}' is not defined in config.yml. "
                            f"Add '{provider_name}:' to the 'providers:' section in config.yml"
                        )
                    # Check if provider has mcp_config path
                    else:
                        mcp_config = available_providers[provider_name].get(
                            "mcp_config"
                        )
                        # Check if mcp_config exists, is a string, and is not empty/whitespace
                        if (
                            not mcp_config
                            or not isinstance(mcp_config, str)
                            or not mcp_config.strip()
                        ):
                            validation_errors.append(
                                f"MCP server '{server.name}' is enabled for provider '{provider_name}', "
                                f"but provider '{provider_name}' has no valid 'mcp_config' path configured. "
                                f"Add 'mcp_config: <path>' to providers.{provider_name} in config.yml "
                                f"(current value: {repr(mcp_config)})"
                            )

        # Raise error if validation failed
        if validation_errors:
            error_message = (
                "MCP server configuration validation failed:\n\n"
                + "\n\n".join(f"  • {error}" for error in validation_errors)
            )
            raise ValueError(error_message)

        # Generate and write configs for each provider
        success_count = 0
        generators = {
            "claude": MCPGenerator.generate_claude_format,
            "gemini": MCPGenerator.generate_gemini_format,
            "opencode": MCPGenerator.generate_opencode_format,
        }

        for provider, generator_func in generators.items():
            # Get provider config and check for mcp_config path
            provider_config = self.config.get("providers", {}).get(provider, {})
            if not provider_config or "mcp_config" not in provider_config:
                continue

            target_path = Path(provider_config["mcp_config"]).expanduser()
            config_data = generator_func(servers)

            # Determine MCP key for this provider
            mcp_key = "mcpServers" if provider in ["claude", "gemini"] else "mcp"

            # Protect against empty sync (all servers disabled) deleting manual servers
            if mcp_key in config_data and not config_data[mcp_key]:
                print(
                    f"Warning: No enabled servers for {provider}, skipping to preserve existing servers"
                )
                continue

            if self.merge_json_file(target_path, config_data):
                success_count += 1

        return success_count

    def sync_all(self) -> int:
        """Process all templates and generate provider configs."""
        templates = self.discover_templates()
        print(f"Found {len(templates)} templates")

        success_count = 0
        for template_path in templates:
            try:
                # Skip README files
                if template_path.name == "README.md":
                    continue

                # Parse template
                template = FrontmatterParser.parse_file(template_path)

                # Validate and show warnings
                warnings = self.validate_template(template, template_path)
                for warning in warnings:
                    print(f"Warning: {warning}")

                # Generate for each enabled provider
                for provider in template.provider_metadata.keys():
                    provider_config = template.provider_metadata.get(provider, {})

                    # Check if provider is enabled
                    if not provider_config.get("enabled", False):
                        continue  # Skip disabled/missing providers

                    content = self.generator.generate_file_content(template, provider)
                    output_path = self.get_output_path(
                        template_path, provider, template.type, self.config
                    )

                    if self.write_generated_file(output_path, content):
                        success_count += 1

            except Exception as e:
                print(f"Error processing {template_path}: {e}", file=sys.stderr)

        return success_count


def parse_arguments() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Synchronize agent and command templates to provider configurations",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Use config.yml in script directory (default)
  %(prog)s

  # Use custom config file
  %(prog)s --config /path/to/my-config.yml
  %(prog)s -c ~/my-project/config.yml
        """,
    )

    parser.add_argument(
        "-c",
        "--config",
        type=Path,
        default=None,
        metavar="FILE",
        help="Path to config file (default: config.yml in script directory)",
    )

    return parser.parse_args()


def main():
    """Main execution function."""
    # Parse command-line arguments
    args = parse_arguments()

    # Determine script directory
    script_dir = Path(__file__).parent

    # Determine config file path: use provided path or default to script directory
    if args.config:
        config_file = args.config.expanduser().resolve()
    else:
        config_file = script_dir / "config.yml"

    # Validate that config file exists
    if not config_file.exists():
        print(
            f"Error: Config file not found at {config_file}",
            file=sys.stderr,
        )
        print(
            f"\nTip: Create a config file or use --config to specify a different location",
            file=sys.stderr,
        )
        return 1

    # Determine templates directory (relative to config file location)
    templates_dir = config_file.parent / "templates"

    # Validation
    if not templates_dir.exists():
        print(
            f"Error: Templates directory not found at {templates_dir}",
            file=sys.stderr,
        )
        print(
            f"\nTip: Templates should be located at {templates_dir} (relative to config file at {config_file})",
            file=sys.stderr,
        )
        return 1

    try:
        # Use specified config for manager initialization
        manager = AgentSyncManager(templates_dir, config_file)

        # Sync templates
        template_count = manager.sync_all()
        print(f"Successfully generated {template_count} template files")

        # Sync MCP servers (using the same config file)
        mcp_count = manager.sync_mcp_servers(config_file)
        print(f"Successfully updated {mcp_count} MCP configuration files")

        return 0 if (template_count > 0 or mcp_count > 0) else 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
