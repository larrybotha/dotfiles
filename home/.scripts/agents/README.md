# Agent Configuration Template System

## Overview

This directory contains a template-driven system for managing AI agent
configurations across multiple service providers (Claude Code, OpenCode).

**Why templates?** Instead of maintaining 32 duplicate files (6 research agents + 10 commands × 2 providers + 11 OpenCode-only agents), we maintain 27 templates as the single source of truth.

## Quick Start

### Sync Templates to Providers

After editing templates, regenerate provider configurations:

```bash
just sync-agents
```

Or run directly:
```bash
cd ~/.scripts/agents
uv run python sync-agents.py
```

### Create New Template

1. Create markdown file in appropriate directory:
   - Agents: `templates/agents/[category]/[name].md`
   - Commands: `templates/commands/g/[name].md`

2. Add YAML frontmatter (see Template Structure below)

3. Add body content (the actual prompt/instructions)

4. Run `just sync-agents` to generate provider files

## Architecture

```
templates/          Source of truth (tracked in git)
  ├── agents/       Agent definitions
  └── commands/     Command definitions

sync-agents.py      Generation script

~/.claude/          Generated Claude files (gitignored)
  ├── agents/
  └── commands/

~/.config/opencode/ Generated OpenCode files (gitignored)
  ├── agent/
  └── command/
```

## Template Structure

Each template is a markdown file with YAML frontmatter containing metadata
for all providers.

### Minimal Template Example

```markdown
---
type: agent
name: example-agent

claude:
  enabled: true

opencode:
  enabled: true
---

Your agent instructions go here.
This is the prompt that will be used by the agent.
```

### Complete Template Example (All Metadata)

```markdown
---
type: agent
name: research-agent
description: Research codebase architecture

claude:
  enabled: true
  tags:
    - research
    - analysis
  model: claude-sonnet-4

opencode:
  enabled: true
  category: research
  keybinding: r
  tags:
    - research
    - codebase
  model: claude-sonnet-4
---

# Research Agent Instructions

You are a research specialist...
```

## Metadata Fields

### Common Fields (All Templates)

- `type`: Required - `agent` or `command`
- `name`: Required - Filename (without `.md`) for generated files
- `description`: Optional - Short description of agent/command purpose

### Provider Sections

Each provider has its own section with:
- `enabled`: Required boolean - Whether to generate files for this provider
- Provider-specific fields (see below)

### Claude Code Specific

- `tags`: Optional list - Categorization tags
- `model`: Optional string - AI model to use

### OpenCode Specific

- `category`: Optional string - Agent category (e.g., `research`, `documentation`)
- `keybinding`: Optional string - Keyboard shortcut
- `tags`: Optional list - Categorization tags
- `model`: Optional string - AI model to use

### OpenCode-Only Templates

For agents that only exist in OpenCode, omit the `claude` section entirely:

```markdown
---
type: agent
name: opencode-only-agent

opencode:
  enabled: true
  category: utility
---

Agent instructions...
```

## Workflow

1. **Edit templates** in `~/.scripts/agents/templates/`
2. **Run sync**: `just sync-agents`
3. **Test configurations** with Claude Code or OpenCode
4. **Commit template changes** (generated files are gitignored)

## Provider-Specific Metadata

### Field Mapping

| Template Field | Claude Code | OpenCode |
|---------------|-------------|----------|
| `type` | Used | Used |
| `name` | Filename | Filename |
| `description` | Description | Description |
| `tags` | Tags | Tags |
| `model` | Model | Model |
| `category` | - | Category |
| `keybinding` | - | Keybinding |

### Example: Different Tags Per Provider

```markdown
---
type: agent
name: research-agent

claude:
  enabled: true
  tags:
    - research

opencode:
  enabled: true
  tags:
    - research
    - codebase
    - analysis
---
```

## Important Notes

- **Templates are the source of truth** - Edit templates, not generated files
- **Generated files are gitignored** - They're recreated from templates
- **OpenCode is canonical** - When creating templates, use OpenCode files as the source
- **Field order doesn't matter** - YAML parsers don't require specific field order

## MCP Server Configuration

MCP (Model Context Protocol) servers can be configured at two levels: global (user-wide) and project-specific.

### Global MCP Servers

Defined in `~/.scripts/agents/config.yml`:

```yaml
# MCP configuration target files per provider
mcp_targets:
  claude: ~/.claude.json
  gemini: ~/.gemini/settings.json
  opencode: ~/.config/opencode/opencode.json

# Global MCP servers (available to all projects by default)
mcp_servers:
  vectorcode-mcp-server:
    command: vectorcode-mcp-server
    args: []
    providers:
      claude:
        enabled: true
      opencode:
        enabled: true
        type: local  # OpenCode-specific metadata
      gemini:
        enabled: true
```

### Project-Level MCP Servers

Defined in `./config.yml` (project root):

```yaml
mcp_servers:
  my-project-api:
    command: node
    args: [./tools/api.js]
    providers:
      claude:
        enabled: true
      opencode:
        enabled: true
        type: local
```

### Disabling Global Servers for a Project

Project configs can disable global servers:

```yaml
mcp_servers:
  # Disable vectorcode for this project
  vectorcode-mcp-server:
    providers:
      claude:
        enabled: false
      opencode:
        enabled: false
```

### How It Works

When you run `sync-agents.py`, it:

1. Loads global MCP servers from `~/.scripts/agents/config.yml`
2. Loads project MCP servers from `./config.yml` (if it exists)
3. Merges servers (project config can add new servers or disable global ones)
4. Generates provider-specific configuration files
5. Preserves existing non-MCP settings in provider configs
6. Creates timestamped backups before updating

### Server Merge Behavior

- **Server-level merge**: Project config completely replaces global server definition
- **Add new server**: Define server only in project config
- **Disable global server**: Set `enabled: false` in project config
- **Override server**: Redefine server completely in project config

### Provider-Specific Metadata

Different providers support different metadata:

- **Claude Code**: `command`, `args` (no extra metadata needed)
- **OpenCode**: `command`, `args`, `type` (e.g., `local`, `remote`)
- **Gemini**: `command`, `args`

Example with provider-specific metadata:

```yaml
mcp_servers:
  my-server:
    command: uvx
    args: [my-mcp-server]
    providers:
      claude:
        enabled: true
      opencode:
        enabled: true
        type: local  # OpenCode requires 'type'
      gemini:
        enabled: false
```

### Backup and Safety Features

The sync script includes safety features:

- **Backups**: Timestamped backups created before each update (`.backup.YYYYMMDD_HHMMSS`)
- **Atomic writes**: Uses temporary files to prevent corruption
- **Empty sync protection**: Warns if no servers would be written
- **JSON validation**: Ensures valid JSON output
- **Deep merge**: Preserves all existing settings in provider configs

### Migration from Old mcp-servers.json

If you previously used `mcp-servers.json` in your project root:

1. Move server definitions to `./config.yml` under `mcp_servers:` key
2. Add provider-specific `enabled` flags
3. Remove old `mcp-servers.json` file
4. Run `just sync-agents` to apply changes

Before (mcp-servers.json):
```json
{
  "vectorcode-mcp-server": {
    "command": "vectorcode-mcp-server",
    "args": []
  }
}
```

After (config.yml):
```yaml
mcp_servers:
  vectorcode-mcp-server:
    command: vectorcode-mcp-server
    args: []
    providers:
      claude: { enabled: true }
      opencode: { enabled: true, type: local }
```

## Troubleshooting

### Generated files not updated
- Run `just sync-agents` after editing templates
- Check template has valid YAML frontmatter
- Verify `enabled: true` for target provider

### Template validation errors
- Ensure frontmatter is between `---` delimiters
- Check YAML syntax (indentation, colons, quotes)
- Verify `type` field is `agent` or `command`

### Provider not generating files
- Check `enabled: true` in provider section
- For OpenCode-only agents, omit `claude` section entirely
- Verify provider paths in `config.yml`

### MCP servers not appearing
- Verify `enabled: true` for each provider in server config
- Check that `mcp_targets` paths in `config.yml` are correct
- Review backup files to see what changed
- Validate YAML syntax in config files
