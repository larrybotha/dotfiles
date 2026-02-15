#!/usr/bin/env python3

"""
Agent and command configuration synchronization script.
Generates provider-specific configurations from unified templates.

Requirements:
    - PyYAML (managed via uv: uv add pyyaml)

Usage:
    uv run python sync-agents.py
"""

import re
import sys
from dataclasses import dataclass
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
            shared_config=frontmatter.get("shared", {}),
            provider_metadata={
                "claude": frontmatter.get("claude", {}),
                "opencode": frontmatter.get("opencode", {}),
            },
        )


class ClaudeGenerator:
    """Generates Claude-format agent and command files."""

    @staticmethod
    def generate_frontmatter(template: TemplateConfig) -> str:
        """Generate Claude-specific YAML frontmatter."""
        # Merge shared config with Claude config (Claude values override)
        config = template.shared_config | template.provider_metadata.get("claude", {})

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
    def generate_file_content(template: TemplateConfig) -> str:
        """Generate complete Claude-format file."""
        frontmatter = ClaudeGenerator.generate_frontmatter(template)
        return f"---\n{frontmatter}---\n\n{template.body}\n"


class OpenCodeGenerator:
    """Generates OpenCode-format agent and command files."""

    @staticmethod
    def generate_frontmatter(template: TemplateConfig) -> str:
        """Generate OpenCode-specific YAML frontmatter."""
        # Merge shared config with OpenCode config (OpenCode values override)
        config = template.shared_config | template.provider_metadata.get("opencode", {})

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
    def generate_file_content(template: TemplateConfig) -> str:
        """Generate complete OpenCode-format file."""
        frontmatter = OpenCodeGenerator.generate_frontmatter(template)
        return f"---\n{frontmatter}---\n\n{template.body}\n"


class AgentSyncManager:
    """Manages the synchronization of agent and command templates."""

    def __init__(self, templates_dir: Path, config_file: Path):
        self.templates_dir = templates_dir
        self.config = self._load_config(config_file)
        self.generators = {"claude": ClaudeGenerator, "opencode": OpenCodeGenerator}

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
        provider_base = Path(config["providers"][provider]).expanduser()

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
                for provider in self.generators.keys():
                    provider_config = template.provider_metadata.get(provider, {})

                    # Check if provider is enabled
                    if not provider_config.get("enabled", False):
                        continue  # Skip disabled/missing providers

                    generator = self.generators[provider]
                    content = generator.generate_file_content(template)
                    output_path = self.get_output_path(
                        template_path, provider, template.type, self.config
                    )

                    if self.write_generated_file(output_path, content):
                        success_count += 1

            except Exception as e:
                print(f"Error processing {template_path}: {e}", file=sys.stderr)

        return success_count


def main():
    """Main execution function."""
    script_dir = Path(__file__).parent
    templates_dir = script_dir / "templates"
    config_file = script_dir / "config.yml"

    if not templates_dir.exists():
        print(
            f"Error: Templates directory not found at {templates_dir}", file=sys.stderr
        )
        return 1

    if not config_file.exists():
        print(f"Error: Config file not found at {config_file}", file=sys.stderr)
        return 1

    try:
        manager = AgentSyncManager(templates_dir, config_file)
        success_count = manager.sync_all()

        print(f"\nSuccessfully generated {success_count} configuration files")
        return 0 if success_count > 0 else 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
