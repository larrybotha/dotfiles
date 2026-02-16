#!/usr/bin/env python3


"""Agent and command configuration synchronization script.

Generates provider-specific configurations from unified templates.

Requirements
------------
- PyYAML (managed via uv: uv add pyyaml)

Usage
-----
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
from typing import Any, Dict, List, Literal, NamedTuple, Optional, Union

import yaml


class ProviderConfig(NamedTuple):
    """Configuration for a provider.

    Attributes
    ----------
    name : str
        Provider name
    mcp_key : str
        Key used in MCP config JSON ("mcpServers" or "mcp")
    agent_dir : Optional[str]
        Directory name for agents (None if not supported)
    command_dir : Optional[str]
        Directory name for commands (None if not supported)
    skill_dir : Optional[str]
        Directory name for skills (None if not supported)
    """

    name: str
    mcp_key: str
    agent_dir: Optional[str]
    command_dir: Optional[str]
    skill_dir: Optional[str]


# Provider configurations
PROVIDERS: Dict[str, ProviderConfig] = {
    "claude": ProviderConfig(
        name="claude",
        mcp_key="mcpServers",
        agent_dir="agents",
        command_dir="commands",
        skill_dir="skills",
    ),
    "gemini": ProviderConfig(
        name="gemini",
        mcp_key="mcpServers",
        # TODO: support Gemini - requires TOML instead of YAML/Markdown
        agent_dir=None,
        command_dir=None,
        skill_dir=None,
    ),
    "opencode": ProviderConfig(
        name="opencode",
        mcp_key="mcp",
        agent_dir="agent",
        command_dir="command",
        skill_dir="skills",
    ),
}


def get_provider_config(provider: str) -> ProviderConfig:
    """Get provider configuration, raising error if unknown.

    Parameters
    ----------
    provider : str
        Provider name to look up

    Returns
    -------
    ProviderConfig
        Configuration for the specified provider

    Raises
    ------
    ValueError
        If provider is unknown
    """
    if provider not in PROVIDERS:
        raise ValueError(
            f"Unknown provider: {provider}. Known providers: {list(PROVIDERS.keys())}"
        )

    return PROVIDERS[provider]


def get_template_providers() -> List[str]:
    """Get list of providers that support templates.

    Returns
    -------
    List[str]
        List of provider names that support template generation
    """
    return [name for name, config in PROVIDERS.items() if config.agent_dir is not None]


@dataclass
class TemplateConfig:
    """Represents a parsed template with metadata.

    Attributes
    ----------
    type : Literal["agent", "command", "skill"]
        Type of template
    body : str
        Template body content
    shared_config : Dict[str, Any]
        Configuration shared across all providers
    provider_metadata : Dict[str, Dict[str, Any]]
        Provider-specific metadata keyed by provider name
    """

    type: Literal["agent", "command", "skill"]
    body: str
    shared_config: Dict[str, Any]
    provider_metadata: Dict[str, Dict[str, Any]]


@dataclass
class MCPServerConfig:
    """Represents a single MCP server configuration.

    Attributes
    ----------
    name : str
        Server name
    command : str
        Command to run the server
    args : List[str]
        Command-line arguments for the server
    providers : Dict[str, Dict[str, Any]]
        Provider-specific configuration mapping provider name to metadata
        containing at minimum {enabled: bool, ...other metadata}
    """

    name: str
    command: str
    args: List[str]
    providers: Dict[str, Dict[str, Any]]


class FrontmatterParser:
    """Parses YAML frontmatter from markdown files."""

    @staticmethod
    def parse_file(template_path: Path) -> TemplateConfig:
        """Parse a template file into a TemplateConfig object.

        Parameters
        ----------
        template_path : Path
            Path to template file

        Returns
        -------
        TemplateConfig
            Parsed template configuration object

        Raises
        ------
        ValueError
            If frontmatter is invalid or skill validation fails
        """
        content = template_path.read_text()
        parts = re.split(r"^---\s*$", content, maxsplit=2, flags=re.MULTILINE)

        if len(parts) < 3:
            raise ValueError(f"No valid frontmatter in {template_path}")

        frontmatter_yaml = parts[1]
        body = parts[2].strip()

        try:
            frontmatter = yaml.safe_load(frontmatter_yaml)
        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML in {template_path}: {e}")

        if "type" not in frontmatter:
            raise ValueError(f"Missing 'type' field in frontmatter: {template_path}")

        template_type = frontmatter["type"]

        provider_metadata = {}

        for provider_name in get_template_providers():
            provider_metadata[provider_name] = frontmatter.get(provider_name, {}) or {}

        return TemplateConfig(
            type=template_type,
            body=body,
            shared_config=frontmatter.get("shared", {}) or {},
            provider_metadata=provider_metadata,
        )


class MCPGenerator:
    """Generates MCP configuration files for different providers."""

    @staticmethod
    def generate_claude_format(servers: List[MCPServerConfig]) -> Dict[str, Any]:
        """Generate Claude format configuration.

        Parameters
        ----------
        servers : List[MCPServerConfig]
            List of MCP server configurations

        Returns
        -------
        Dict[str, Any]
            Configuration dictionary in Claude format: {"mcpServers": {...}}
        """
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
        """Generate Gemini format configuration.

        Parameters
        ----------
        servers : List[MCPServerConfig]
            List of MCP server configurations

        Returns
        -------
        Dict[str, Any]
            Configuration dictionary in Gemini format (same as Claude)
        """
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
        """Generate OpenCode format configuration.

        Parameters
        ----------
        servers : List[MCPServerConfig]
            List of MCP server configurations

        Returns
        -------
        Dict[str, Any]
            Configuration dictionary in OpenCode format: {"mcp": {...}}
        """
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
        """Generate provider-specific YAML frontmatter.

        Parameters
        ----------
        template : TemplateConfig
            Template configuration object
        provider : str
            Provider name

        Returns
        -------
        str
            YAML frontmatter string
        """
        config = template.shared_config | template.provider_metadata.get(provider, {})
        # Remove 'enabled' field - not part of frontmatter
        config = {k: v for k, v in config.items() if k != "enabled"}

        return yaml.dump(
            config,
            default_flow_style=False,
            sort_keys=False,
            width=999999,  # Large width to prevent wrapping
            allow_unicode=True,
        )

    @staticmethod
    def generate_file_content(template: TemplateConfig, provider: str) -> str:
        """Generate complete provider-format file.

        Parameters
        ----------
        template : TemplateConfig
            Template configuration object
        provider : str
            Provider name

        Returns
        -------
        str
            Complete file content with frontmatter and body
        """
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

        Parameters
        ----------
        config_file : Path
            Path to the YAML configuration file

        Raises
        ------
        FileNotFoundError
            If config file or templates directory doesn't exist
        """
        self._config = self._load_config(config_file)
        self._config_file = config_file
        self._generator = TemplateGenerator
        self._templates_dir = self._resolve_templates_dir()
        self._validate_templates_dir()

    def _resolve_templates_dir(self) -> Path:
        """Resolve templates directory from config file location.

        Returns
        -------
        Path
            Path to templates directory (config_file.parent / "templates")
        """
        return self._config_file.parent / "templates"

    def _validate_templates_dir(self) -> None:
        """Validate that templates directory exists.

        Raises
        ------
        FileNotFoundError
            If templates directory doesn't exist
        """
        if not self._templates_dir.exists():
            raise FileNotFoundError(
                f"Templates directory not found at {self._templates_dir}\n"
                f"Expected location: {self._config_file.parent}/templates\n"
                f"Config file: {self._config_file}"
            )

    def _load_config(self, config_file: Path) -> Dict[str, Any]:
        """Load provider configuration from YAML file.

        Parameters
        ----------
        config_file : Path
            Path to YAML configuration file

        Returns
        -------
        Dict[str, Any]
            Loaded configuration dictionary

        Raises
        ------
        FileNotFoundError
            If config file doesn't exist
        """
        if not config_file.exists():
            raise FileNotFoundError(f"Config file not found: {config_file}")

        with open(config_file, "r") as f:
            return yaml.safe_load(f)

    def discover_templates(self) -> List[Path]:
        """Find all template markdown files.

        Supports patterns:
        - Agents: templates/agents/*.md (flat files or subdirectories)
        - Commands: templates/commands/*.md (flat files or subdirectories)
        - Skills: templates/skills/*/SKILL.md (must be in subdirectories)

        Returns
        -------
        List[Path]
            Deduplicated sorted list of template file paths
        """
        templates = set()

        # Find all markdown files (flat files and files in subdirectories)
        for md_file in self._templates_dir.rglob("*.md"):
            templates.add(md_file)

        return sorted(templates)

    def get_output_path(
        self,
        *,
        config: Dict,
        provider: str,
        template_path: Path,
        template_type: str,
    ) -> Path:
        """Calculate output path for a generated file.

        Parameters
        ----------
        config : Dict
            Configuration dictionary
        provider : str
            Provider name
        template_path : Path
            Path to the template file
        template_type : str
            Type of template (agent, command, skill)

        Returns
        -------
        Path
            Output path for the generated file

        Raises
        ------
        ValueError
            If templates_dir is not configured, template type is unknown,
            or provider doesn't support the template type
        """
        # Get provider configuration
        provider_cfg = get_provider_config(provider)

        # Get relative path from templates/{type}s/ directory
        type_dir = self._templates_dir / (template_type + "s")
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
        elif template_type == "skill":
            subdir = provider_cfg.skill_dir
        else:
            raise ValueError(f"Unknown template type: {template_type}")

        if subdir is None:
            raise ValueError(
                f"Provider {provider} does not support template type {template_type}"
            )

        # Build full path: base / subdir / relative_path
        base_dir = provider_base / subdir

        # For skills, create nested directory structure
        if template_type == "skill":
            skill_name = rel_path.parts[0]
            return base_dir / skill_name / "SKILL.md"

        return base_dir / rel_path

    def write_generated_file(self, output_path: Path, content: str) -> bool:
        """Write generated content to output file.

        Parameters
        ----------
        output_path : Path
            Path to the output file
        content : str
            Content to write

        Returns
        -------
        bool
            True if write was successful, False otherwise
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            output_path.write_text(content)
            print(f"Generated: {output_path}")

            return True
        except Exception as e:
            print(f"Error writing {output_path}: {e}", file=sys.stderr)

            return False

    def copy_skill_directory(
        self, skill_dir: Path, output_dir: Path, skip_files: Optional[List[str]] = None
    ) -> tuple[int, int]:
        """Copy all files from skill directory to output, excluding specified files.

        Parameters
        ----------
        skill_dir : Path
            Source skill directory
        output_dir : Path
            Destination directory
        skip_files : Optional[List[str]], optional
            List of filenames to skip (defaults to template files)

        Returns
        -------
        tuple[int, int]
            Tuple of (files_copied, errors_encountered)

        Notes
        -----
        - Symlinks are followed (not preserved as symlinks)
        - Broken symlinks are skipped with warning
        - Existing files are overwritten
        - Empty directories are not created
        - Files larger than 10MB are skipped with warning
        """
        if skip_files is None:
            skip_files = ["SKILL.md", "skill.md", ".DS_Store", ".gitkeep"]

        # Convert to set for O(1) lookups and normalize case for macOS
        skip_files_set = {name.upper() for name in skip_files}

        if not skill_dir.exists():
            print(f"Warning: Source directory not found: {skill_dir}", file=sys.stderr)
            return (0, 0)

        if not skill_dir.is_dir():
            print(
                f"Warning: Source path is not a directory: {skill_dir}",
                file=sys.stderr,
            )
            return (0, 0)

        copied_count = 0
        error_count = 0
        MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB

        try:
            for item in skill_dir.rglob("*"):
                # Skip files in the ignore list (case-insensitive)
                if item.name.upper() in skip_files_set:
                    continue

                # Skip broken symlinks
                if item.is_symlink() and not item.exists():
                    print(
                        f"Warning: Skipping broken symlink: {item.relative_to(skill_dir)}",
                        file=sys.stderr,
                    )
                    error_count += 1
                    continue

                if not item.is_file():
                    continue

                # Calculate destination path
                rel_path = item.relative_to(skill_dir)
                dest_path = output_dir / rel_path

                try:
                    # Check file size
                    file_size = item.stat().st_size
                    if file_size > MAX_FILE_SIZE:
                        print(
                            f"Warning: Skipping large file ({file_size / 1024 / 1024:.1f}MB): {rel_path}",
                            file=sys.stderr,
                        )
                        error_count += 1
                        continue

                    # Create parent directories
                    dest_path.parent.mkdir(parents=True, exist_ok=True)

                    # Copy file (preserves metadata with copy2)
                    shutil.copy2(item, dest_path)
                    copied_count += 1

                except PermissionError as e:
                    print(
                        f"Warning: Permission denied copying {rel_path}: {e}",
                        file=sys.stderr,
                    )
                    error_count += 1
                except OSError as e:
                    print(
                        f"Warning: Failed to copy {rel_path}: {e}",
                        file=sys.stderr,
                    )
                    error_count += 1

        except Exception as e:
            print(
                f"Error: Failed to traverse directory {skill_dir}: {e}",
                file=sys.stderr,
            )
            return (copied_count, error_count + 1)

        return (copied_count, error_count)

    def _deep_merge_mcp_servers(
        self, existing: Dict[str, Any], new: Dict[str, Any], mcp_key: str
    ) -> Dict[str, Any]:
        """Merge MCP server configurations, replacing the entire MCP servers section.

        This method treats config.yml as the source of truth for MCP servers.
        All servers in the JSON file are replaced with those from config.yml.
        Other top-level keys in the JSON file are preserved.

        Parameters
        ----------
        existing : Dict[str, Any]
            Existing configuration dictionary
        new : Dict[str, Any]
            New configuration dictionary
        mcp_key : str
            Key for MCP servers ("mcpServers" or "mcp")

        Returns
        -------
        Dict[str, Any]
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
        self, target_path: Path, new_data: Dict[str, Any], mcp_key: str
    ) -> tuple[bool, Union[Path, None]]:
        """Merge new configuration data into existing JSON file.

        Parameters
        ----------
        target_path : Path
            Path to target JSON file
        new_data : Dict[str, Any]
            New configuration data to merge
        mcp_key : str
            MCP configuration key format for this provider (e.g., "mcpServers", "mcp")

        Returns
        -------
        tuple[bool, Path | None]
            Tuple of (success, backup_path)
            - success: True if merge was successful, False otherwise
            - backup_path: Path to backup file created, or None if no backup was created
        """
        target_path.parent.mkdir(parents=True, exist_ok=True)
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

        # Get all possible MCP keys from provider configs
        all_mcp_keys = {cfg.mcp_key for cfg in PROVIDERS.values()}
        other_mcp_keys = all_mcp_keys - {mcp_key}

        # Normalize existing config by migrating from any other MCP key format
        for other_key in other_mcp_keys:
            if other_key in existing_config:
                if mcp_key in existing_config:
                    # Both keys exist - warn and prefer provider's key
                    print(
                        f"Warning: {target_path} has both '{mcp_key}' and '{other_key}'. "
                        f"Using '{mcp_key}' and discarding '{other_key}'.",
                        file=sys.stderr,
                    )
                # Migrate from other key format to provider's expected key format
                existing_config[mcp_key] = existing_config.pop(other_key)

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

    def _validate_skill_template(self, template_path: Path) -> None:
        """Validate skill template requirements.

        Skills must follow the pattern: templates/skills/<skill-name>/SKILL.md
        where <skill-name> is exactly one directory level deep.

        Parameters
        ----------
        template_path : Path
            Path to skill template file

        Raises
        ------
        ValueError
            If skill validation fails
        """
        skills_dir = self._templates_dir / "skills"

        # Check that skill is in a subdirectory of skills/
        try:
            rel_path = template_path.relative_to(skills_dir)
        except ValueError:
            raise ValueError(
                f"Skill template must be in subdirectory of skills/: {template_path}"
            )

        # Skills must be exactly one directory level deep (not flat, not nested deeper)
        if len(rel_path.parts) != 2:
            if len(rel_path.parts) == 1:
                raise ValueError(
                    f"Skill template must be in a subdirectory of skills/ "
                    f"(e.g., skills/my-skill/SKILL.md), not directly in skills/: {template_path}"
                )
            else:
                raise ValueError(
                    f"Skill template must be exactly one directory deep "
                    f"(e.g., skills/my-skill/SKILL.md), not nested deeper: {template_path}"
                )

        # Filename must be exactly SKILL.md (case-sensitive)
        if template_path.name != "SKILL.md":
            raise ValueError(
                f"Skill template filename must be exactly 'SKILL.md' (case-sensitive), "
                f"found '{template_path.name}'. Please rename: {template_path}"
            )

    def validate_template(
        self, template: TemplateConfig, template_path: Path
    ) -> List[str]:
        """Validate template configuration and return warnings.

        Parameters
        ----------
        template : TemplateConfig
            Parsed template configuration
        template_path : Path
            Path to template file

        Returns
        -------
        List[str]
            List of warning messages

        Raises
        ------
        ValueError
            If skill validation fails
        """
        # Validate skills have correct structure
        if template.type == "skill":
            self._validate_skill_template(template_path)

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
        """Delete backup files after successful sync.

        Parameters
        ----------
        backup_paths : List[Path]
            List of backup file paths to delete
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
        """Load MCP servers from the config loaded during initialization.

        Returns
        -------
        List[MCPServerConfig]
            List of MCP server configuration objects
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
        """Synchronize MCP server configurations to provider files.

        Returns
        -------
        int
            Number of successfully updated files

        Raises
        ------
        ValueError
            If validation of provider configurations fails
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
                target_path, config_data, mcp_key
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

    def _get_template_mappings(self) -> Dict[str, Dict[str, set[Path]]]:
        """Calculate file mappings for all templates (enabled and disabled).

        Returns
        -------
        Dict[str, Dict[str, set[Path]]]
            Nested dictionary: {"enabled": {provider: set[Path]}, "disabled": {provider: set[Path]}}
        """
        templates = self.discover_templates()
        enabled_files: Dict[str, set[Path]] = {
            provider: set() for provider in get_template_providers()
        }
        disabled_files: Dict[str, set[Path]] = {
            provider: set() for provider in get_template_providers()
        }

        for template_path in templates:
            try:
                # Skip README files
                if template_path.name == "README.md":
                    continue

                template = FrontmatterParser.parse_file(template_path)

                # Track files for each provider (enabled or disabled)
                for provider in template.provider_metadata.keys():
                    provider_config = template.provider_metadata.get(provider, {})

                    output_path = self.get_output_path(
                        config=self._config,
                        provider=provider,
                        template_path=template_path,
                        template_type=template.type,
                    )

                    # Categorize by enabled status
                    target_dict = (
                        enabled_files
                        if provider_config.get("enabled", False)
                        else disabled_files
                    )

                    # For skills, track the entire directory
                    if template.type == "skill":
                        target_dict[provider].add(output_path.parent)
                    else:
                        target_dict[provider].add(output_path)

            except Exception:
                # Ignore errors during tracking - they'll be reported during generation
                pass

        return {"enabled": enabled_files, "disabled": disabled_files}

    def _cleanup_disabled_templates(self, disabled_files: Dict[str, set[Path]]) -> int:
        """Remove files/directories for disabled templates only.

        Only removes files that correspond to templates that exist but are disabled.
        This prevents removal of manually created files.

        Parameters
        ----------
        disabled_files : Dict[str, set[Path]]
            Dictionary mapping provider name to set of disabled file/directory paths

        Returns
        -------
        int
            Number of files/directories removed
        """
        removed_count = 0

        for provider in get_template_providers():
            disabled = disabled_files.get(provider, set())

            for path in disabled:
                if not path.exists():
                    continue

                try:
                    if path.is_dir():
                        shutil.rmtree(path)
                        print(f"Removed disabled skill: {path}")
                        removed_count += 1
                    else:
                        path.unlink()
                        path_type = "agent" if "agent" in str(path) else "command"
                        print(f"Removed disabled {path_type}: {path}")
                        removed_count += 1

                        # Clean up empty parent directories
                        provider_config = self._config["providers"][provider]
                        templates_dir = provider_config.get("templates_dir")
                        if templates_dir:
                            provider_base = Path(templates_dir).expanduser()
                            provider_cfg = PROVIDERS[provider]
                            # Determine stop directory based on path
                            if "agent" in str(path) and provider_cfg.agent_dir:
                                stop_dir = provider_base / provider_cfg.agent_dir
                            elif "command" in str(path) and provider_cfg.command_dir:
                                stop_dir = provider_base / provider_cfg.command_dir
                            else:
                                stop_dir = provider_base
                            self._cleanup_empty_directories(path.parent, stop_dir)

                except Exception as e:
                    print(
                        f"Warning: Failed to remove {path}: {e}",
                        file=sys.stderr,
                    )

        return removed_count

    def _cleanup_empty_directories(self, directory: Path, stop_at: Path) -> None:
        """Recursively remove empty directories up to stop_at directory.

        Parameters
        ----------
        directory : Path
            Directory to start cleanup from
        stop_at : Path
            Directory to stop at (not removed even if empty)
        """
        try:
            # Don't remove the base directory
            if not directory.exists():
                return

            if directory == stop_at or not directory.is_relative_to(stop_at):
                return

            # Only remove if empty
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
                print(f"Removed empty directory: {directory}")

                # Try to remove parent if it's now empty
                self._cleanup_empty_directories(directory.parent, stop_at)

        except Exception:
            # Silently ignore errors during directory cleanup
            pass

    def sync_all(self) -> int:
        """Process all templates and generate provider configs.

        Returns
        -------
        int
            Number of successfully generated files
        """
        templates = self.discover_templates()
        print(f"Found {len(templates)} templates")

        # Track enabled and disabled files before generation
        mappings = self._get_template_mappings()
        disabled_files = mappings["disabled"]

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

                    content = self._generator.generate_file_content(template, provider)
                    output_path = self.get_output_path(
                        config=self._config,
                        provider=provider,
                        template_path=template_path,
                        template_type=template.type,
                    )

                    if self.write_generated_file(output_path, content):
                        success_count += 1

                        # For skills, copy additional files from skill directory
                        if template.type == "skill":
                            skill_source_dir = template_path.parent
                            skill_output_dir = output_path.parent
                            copied, errors = self.copy_skill_directory(
                                skill_source_dir, skill_output_dir
                            )
                            if copied > 0:
                                print(f"  Copied {copied} additional file(s)")
                            if errors > 0:
                                print(
                                    f"  Warning: {errors} file(s) failed to copy",
                                    file=sys.stderr,
                                )

            except Exception as e:
                print(f"Error processing {template_path}: {e}", file=sys.stderr)

        # Clean up disabled templates (not manually created files)
        removed_count = self._cleanup_disabled_templates(disabled_files)

        if removed_count > 0:
            print(f"Cleaned up {removed_count} disabled/removed template(s)")

        return success_count


def parse_arguments() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns
    -------
    argparse.Namespace
        Parsed command-line arguments
    """
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
    """Main execution function.

    Returns
    -------
    int
        Exit code (0 for success, 1 for failure)
    """
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
