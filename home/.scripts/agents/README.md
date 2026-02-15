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
