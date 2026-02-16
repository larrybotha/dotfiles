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
from textwrap import dedent
from typing import Any, Dict, List, Literal, NamedTuple, Optional

import yaml


# Provider configuration structure
class ProviderConfig(NamedTuple):
    """Configuration for a provider."""

    name: str
    mcp_key: str  # Key used in MCP config JSON ("mcpServers" or "mcp")
    agent_dir: Optional[str]  # Directory name for agents (None if not supported)
    command_dir: Optional[str]  # Directory name for commands (None if not supported)


# Provider configurations
PROVIDERS: Dict[str, ProviderConfig] = {
    "claude": ProviderConfig(
        name="claude",
        mcp_key="mcpServers",
        agent_dir="agents",
        command_dir="commands",
    ),
    "gemini": ProviderConfig(
        name="gemini",
        mcp_key="mcpServers",
        agent_dir=None,  # Gemini doesn't use templates
        command_dir=None,
    ),
    "opencode": ProviderConfig(
        name="opencode",
        mcp_key="mcp",
        agent_dir="agent",
        command_dir="command",
    ),
}


def get_provider_config(provider: str) -> ProviderConfig:
    """Get provider configuration, raising error if unknown."""
    if provider not in PROVIDERS:
        raise ValueError(
            f"Unknown provider: {provider}. Known providers: {list(PROVIDERS.keys())}"
        )
    return PROVIDERS[provider]


def get_template_providers() -> List[str]:
    """Get list of providers that support templates."""
    return [name for name, config in PROVIDERS.items() if config.agent_dir is not None]


@dataclass
class TemplateConfig:
    """Represents a parsed template with metadata."""

    type: Literal["agent"] | Literal["command"]
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

        # Extract metadata for providers that support templates
        provider_metadata = {}
        for provider_name in get_template_providers():
            provider_metadata[provider_name] = frontmatter.get(provider_name, {}) or {}

        return TemplateConfig(
            type=frontmatter["type"],
            body=body,
            shared_config=frontmatter.get("shared", {}) or {},
            provider_metadata=provider_metadata,
        )


class MCPGenerator:
    """Generates MCP configuration files for different providers."""

    @staticmethod
    def generate_claude_format(servers: List[MCPServerConfig]) -> Dict[str, Any]:
        """Generate Claude format: {"mcpServers": {...}}"""
        provider = get_provider_config("claude")
        mcp_servers = {}
        for server in servers:
            provider_config = server.providers.get(provider.name, {})
            if provider_config.get("enabled", False):
                mcp_servers[server.name] = {
                    "command": server.command,
                    "args": server.args,
                }
        return {provider.mcp_key: mcp_servers}

    @staticmethod
    def generate_gemini_format(servers: List[MCPServerConfig]) -> Dict[str, Any]:
        """Generate Gemini format (same as Claude)."""
        provider = get_provider_config("gemini")
        mcp_servers = {}
        for server in servers:
            provider_config = server.providers.get(provider.name, {})
            if provider_config.get("enabled", False):
                mcp_servers[server.name] = {
                    "command": server.command,
                    "args": server.args,
                }
        return {provider.mcp_key: mcp_servers}

    @staticmethod
    def generate_opencode_format(servers: List[MCPServerConfig]) -> Dict[str, Any]:
        """Generate OpenCode format: {"mcp": {...}}"""
        provider = get_provider_config("opencode")
        mcp = {}
        for server in servers:
            provider_config = server.providers.get(provider.name, {})
            if provider_config.get("enabled", False):
                mcp[server.name] = {
                    "type": provider_config.get("type", "local"),
                    "command": [server.command] + server.args,
                    "enabled": True,
                }
        return {provider.mcp_key: mcp}


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
    """Manages the synchronization of agent and command templates.

    The manager automatically resolves the templates directory from the config file
    location, expecting templates to be in a 'templates/' subdirectory adjacent to
    the config file.
    """

    def __init__(self, config_file: Path):
        """Initialize AgentSyncManager with config file.

        Args:
            config_file: Path to the YAML configuration file

        Raises:
            FileNotFoundError: If config file or templates directory doesn't exist
        """
        self.config_file = config_file
        self._config = self._load_config(config_file)
        self.templates_dir = self._resolve_templates_dir()
        self._validate_templates_dir()
        self.generator = TemplateGenerator

    def _resolve_templates_dir(self) -> Path:
        """Resolve templates directory from config file location.

        Returns:
            Path to templates directory (config_file.parent / "templates")
        """
        return self.config_file.parent / "templates"

    def _validate_templates_dir(self) -> None:
        """Validate that templates directory exists.

        Raises:
            FileNotFoundError: If templates directory doesn't exist
        """
        if not self.templates_dir.exists():
            raise FileNotFoundError(
                f"Templates directory not found at {self.templates_dir}\n"
                f"Expected location: {self.config_file.parent}/templates\n"
                f"Config file: {self.config_file}"
            )

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
        # Get provider configuration
        provider_cfg = get_provider_config(provider)

        # Get relative path from templates/{type}s/ directory
        type_dir = self.templates_dir / (template_type + "s")
        rel_path = template_path.relative_to(type_dir)

        # Provider base paths from config
        provider_config = config["providers"][provider]
        templates_dir = provider_config.get("templates_dir")

        if not templates_dir:
            raise ValueError(f"No templates_dir configured for provider: {provider}")

        provider_base = Path(templates_dir).expanduser()

        # Get subdirectory based on template type
        if template_type == "agent":
            subdir = provider_cfg.agent_dir
        elif template_type == "command":
            subdir = provider_cfg.command_dir
        else:
            raise ValueError(f"Unknown template type: {template_type}")

        if subdir is None:
            raise ValueError(
                f"Provider {provider} does not support template type {template_type}"
            )

        # Build full path: base / subdir / relative_path
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
        Merge MCP server configurations, replacing the entire MCP servers section.

        This method treats config.yml as the source of truth for MCP servers.
        All servers in the JSON file are replaced with those from config.yml.
        Other top-level keys in the JSON file are preserved.

        Args:
            existing: Existing configuration dictionary
            new: New configuration dictionary
            mcp_key: Key for MCP servers ("mcpServers" or "mcp")

        Returns:
            Merged configuration dictionary
        """
        result = existing.copy()

        # Replace the entire MCP servers section with what's in config.yml
        # This makes config.yml the source of truth for server configurations
        if mcp_key in new:
            result[mcp_key] = new[mcp_key]

        # Add any other top-level keys from new config
        for key, value in new.items():
            if key != mcp_key:
                result[key] = value

        return result

    def merge_json_file(
        self, target_path: Path, new_data: Dict[str, Any], provider: str
    ) -> tuple[bool, Path | None]:
        """
        Merge new configuration data into existing JSON file.

        Args:
            target_path: Path to target JSON file
            new_data: New configuration data to merge
            provider: Provider name (e.g., "claude", "gemini", "opencode")

        Returns:
            Tuple of (success: bool, backup_path: Path | None)
            - success: True if merge was successful, False otherwise
            - backup_path: Path to backup file created, or None if no backup was created
        """
        # Create parent directory if needed
        target_path.parent.mkdir(parents=True, exist_ok=True)

        # Create timestamped backup of existing file
        backup_path = None
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
                backup_path = None  # Reset if backup failed

        # Load existing config or start with empty dict
        existing_config = {}
        if target_path.exists():
            try:
                existing_config = json.loads(target_path.read_text())
            except json.JSONDecodeError as e:
                print(f"Warning: Could not parse {target_path}: {e}", file=sys.stderr)
                print(f"Creating new file at {target_path}", file=sys.stderr)

        # Get the MCP key for this provider
        provider_config = get_provider_config(provider)
        mcp_key = provider_config.mcp_key

        # Normalize existing config to use provider's expected key (prevent
        # dual-key configs)
        # Determine the "other" MCP key that might exist in legacy configs
        other_mcp_key = "mcp" if mcp_key == "mcpServers" else "mcpServers"

        if existing_config and other_mcp_key in existing_config:
            # Migrate from other key format to provider's expected key format
            existing_config[mcp_key] = existing_config.pop(other_mcp_key)

        # Deep merge MCP servers to preserve existing servers
        merged_config = self._deep_merge_mcp_servers(existing_config, new_data, mcp_key)

        # Write merged config atomically using temp file
        temp_path = target_path.with_suffix(target_path.suffix + ".tmp")

        try:
            temp_path.write_text(json.dumps(merged_config, indent=2) + "\n")
            # Atomic rename
            temp_path.replace(target_path)
            print(f"Updated MCP config: {target_path}")

            return (True, backup_path)
        except Exception as e:
            print(f"Error writing {target_path}: {e}", file=sys.stderr)

            if temp_path.exists():
                temp_path.unlink()

            return (False, None)

    def validate_template(
        self, template: TemplateConfig, template_path: Path
    ) -> List[str]:
        """Validate template configuration and return warnings."""
        warnings = []
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

    def _cleanup_backups(self, backup_paths: List[Path]) -> None:
        """
        Delete backup files after successful sync.

        Args:
            backup_paths: List of backup file paths to delete
        """
        if not backup_paths:
            return

        for backup_path in backup_paths:
            try:
                if backup_path.exists():
                    backup_path.unlink()
                    print(f"Deleted backup: {backup_path}")
            except Exception as e:
                # Log error but don't fail the sync
                print(
                    f"Warning: Could not delete backup {backup_path}: {e}",
                    file=sys.stderr,
                )

    def load_mcp_servers(self) -> List[MCPServerConfig]:
        """
        Load MCP servers from the config loaded during initialization.

        Returns:
            List of MCPServerConfig objects
        """
        servers_dict = self._config.get("mcp_servers", {})
        servers = []

        for name, server_data in servers_dict.items():
            servers.append(
                MCPServerConfig(
                    name=name,
                    command=server_data["command"],
                    args=server_data.get("args", []),
                    providers=server_data.get("providers", {}),
                )
            )

        return servers

    def sync_mcp_servers(self) -> int:
        """
        Synchronize MCP server configurations to provider files.

        Returns:
            Number of successfully updated files
        """
        servers = self.load_mcp_servers()

        if not servers:
            print("No MCP servers configured")

            return 0

        backup_files: List[Path] = []

        # Validate that all enabled providers have mcp_config paths
        validation_errors = []
        available_providers = self._config.get("providers", {})

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
                        has_mcp_config = any(
                            (
                                mcp_config,
                                isinstance(mcp_config, str),
                                mcp_config.strip(),
                            )
                        )

                        if not has_mcp_config:
                            validation_errors.append(
                                f"MCP server '{server.name}' is enabled for provider '{provider_name}', "
                                f"but provider '{provider_name}' has no valid 'mcp_config' path configured. "
                                f"Add 'mcp_config: <path>' to providers.{provider_name} in config.yml "
                                f"(current value: {repr(mcp_config)})"
                            )

        if validation_errors:
            error_message = (
                "MCP server configuration validation failed:\n\n"
                + "\n\n".join(f"  • {error}" for error in validation_errors)
            )
            raise ValueError(error_message)

        success_count = 0
        generators = {
            "claude": MCPGenerator.generate_claude_format,
            "gemini": MCPGenerator.generate_gemini_format,
            "opencode": MCPGenerator.generate_opencode_format,
        }

        for provider_name, generator_func in generators.items():
            provider_cfg = get_provider_config(provider_name)
            provider_config = self._config.get("providers", {}).get(provider_name, {})

            if not provider_config or "mcp_config" not in provider_config:
                continue

            target_path = Path(provider_config["mcp_config"]).expanduser()
            config_data = generator_func(servers)
            mcp_key = provider_cfg.mcp_key

            # Protect against empty sync (all servers disabled) deleting manual servers
            if mcp_key in config_data and not config_data[mcp_key]:
                print(
                    dedent(f"""
                    Warning: No enabled servers for {provider_name},
                    skipping to preserve existing servers
                    """)
                )
                continue

            success, backup_path = self.merge_json_file(
                target_path, config_data, provider_name
            )
            if success:
                success_count += 1

                if backup_path:
                    backup_files.append(backup_path)
            else:
                print(
                    f"Sync failed for {provider_name}, keeping all backups for recovery"
                )

                return success_count

        self._cleanup_backups(backup_files)

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

                template = FrontmatterParser.parse_file(template_path)
                warnings = self.validate_template(template, template_path)

                for warning in warnings:
                    print(f"Warning: {warning}")

                # Generate for each enabled provider
                for provider in template.provider_metadata.keys():
                    provider_config = template.provider_metadata.get(provider, {})

                    # skip if provider is not enabled
                    if not provider_config.get("enabled", False):
                        continue

                    content = self.generator.generate_file_content(template, provider)
                    output_path = self.get_output_path(
                        template_path, provider, template.type, self._config
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
    args = parse_arguments()
    script_dir = Path(__file__).parent
    config_file = (
        args.config.expanduser().resolve() if args.config else script_dir / "config.yml"
    )

    if not config_file.exists():
        print(
            f"Error: Config file not found at {config_file}",
            file=sys.stderr,
        )
        print(
            dedent("""
                Tip: Create a config file or use --config to specify a different
                location
            """),
            file=sys.stderr,
        )
        return 1

    try:
        manager = AgentSyncManager(config_file)

        template_count = manager.sync_all()
        print(f"Successfully generated {template_count} template files")

        mcp_count = manager.sync_mcp_servers()
        print(f"Successfully updated {mcp_count} MCP configuration files")

        return 0 if (template_count > 0 or mcp_count > 0) else 1
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
