# Agent Configuration System

Template-driven system for managing AI agents, commands, and skills across multiple providers (Claude Code, OpenCode).

## Quick Start

Sync templates to providers after editing `config.yml`:

```bash
uv run python sync-agents.py
```

## Architecture

```
./templates/        # Source of truth (git-tracked)
├── agents/         # Agent definitions
├── commands/       # Command definitions
└── skills/         # Skill definitions
    └── <name>/SKILL.md  # Must be in subdirectory

path/to/claude/configs/          # Generated (gitignored)
├── agents/
├── commands/
└── skills/<name>/SKILL.md

path/to/opencode/configs/          # Generated (gitignored)
├── agent/
├── command/
└── skills/<name>/SKILL.md
```

## Template Types

### Agents

**Flat files**: `templates/agents/[category]/[name].md`

**Documentation**:

- [Claude Code agents](https://claude.ai/docs/agents)
- [OpenCode agents](https://opencode.ai/docs/agents)

```yaml
---
type: agent
shared:
  description: Brief description
claude:
  enabled: true
  model: sonnet
  tools: Read, Grep, Glob
opencode:
  enabled: true
  mode: subagent
  model: anthropic/claude-sonnet-4-5
---
Agent instructions here...
```

### Commands

**Flat files**: `templates/commands/[category]/[name].md`

**Documentation**:

- [Claude Code commands](https://claude.ai/docs/commands)
- [OpenCode commands](https://opencode.ai/docs/commands)

```yaml
---
type: command
shared:
  description: Brief description
claude:
  enabled: true
opencode:
  enabled: true
---
Command instructions here...
```

### Skills

**Must be in subdirectory**: `templates/skills/<skill-name>/SKILL.md`

**Documentation**:

- [Claude Code skills](https://claude.ai/docs/skills)
- [OpenCode skills](https://opencode.ai/docs/skills)

```yaml
---
type: skill
shared:
  name: skill-name
  description: Brief description
claude:
  enabled: true
  version: 1.0.0
opencode:
  enabled: true
  license: MIT
  metadata:
    category: backend
---
Skill content here...
```

**Supporting files**: Place additional files in skill directory (copied automatically)

```
my-skill/
├── SKILL.md (required - overview and navigation)
├── reference.md (detailed API docs - loaded when needed)
├── examples.md (usage examples - loaded when needed)
└── scripts/
    └── helper.py (utility script - executed, not loaded)
```

## Metadata Fields

### Common (All Types)

- `type`: Required - `agent`, `command`, or `skill`
- `shared.description`: Recommended - Brief description

### Skills Only

- `shared.name`: Required - Kebab-case, 1-64 chars

## Workflow

1. Edit template in `templates/`
2. Run `just sync-agents`
3. Test with provider
4. Commit template (generated files gitignored)

## Cleanup

Disabling a template (`enabled: false`) removes generated files on sync.

## MCP Server Configuration

Define in `~/.scripts/agents/config.yml` (global) or `./config.yml` (project):

```yaml
mcp_servers:
  vectorcode-mcp-server:
    command: vectorcode-mcp-server
    args: []
    providers:
      claude: { enabled: true }
      opencode: { enabled: true, type: local }
      gemini: { enabled: true }
```

**Behavior**:

- Project config can add servers or disable global ones
- Server-level merge (project replaces global entirely)
- Timestamped backups before updates
- Atomic writes prevent corruption

## Validation Rules

### Skills

- Must be in subdirectory: `skills/<name>/SKILL.md`
- Filename must be exactly `SKILL.md` (case-sensitive)
- Must be exactly one directory deep (not `skills/a/b/SKILL.md`)
- `shared.name` must match directory name

### All Templates

- Valid YAML frontmatter between `---` delimiters
- `type` must be `agent`, `command`, or `skill`
- At least one provider must have `enabled: true`

## Troubleshooting

**Templates not generating**:

- Check `enabled: true` for provider
- Verify YAML syntax (run script for validation errors)

**Skills not generating**:

- Ensure `SKILL.md` filename (case-sensitive)
- Verify subdirectory structure: `skills/<name>/SKILL.md`
- Check `shared.name` matches directory name

**Files not removed**:

- Set `enabled: false` and re-run sync
- Script automatically removes disabled templates
