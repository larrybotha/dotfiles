# Agent and Command Templates

This directory contains template files for AI agent and command configurations that are synchronized across multiple service providers (Claude Code, OpenCode).

## Template Structure

Each template file is a Markdown file with YAML frontmatter that defines metadata and a body containing the prompt/instructions.

### Basic Template Format

```yaml
---
# Template metadata
type: agent  # or "command"

# Shared section - only for fields that are IDENTICAL across providers
shared:
  description: A description that is the same for all providers

# Provider sections - specify exact format each provider expects
claude:
  enabled: true
  # Claude-specific fields here

opencode:
  enabled: true
  # OpenCode-specific fields here
---

[Body content - the actual prompt/instructions]
```

### Key Principles

1. **`type` field**: Must be either `agent` or `command`. This determines:
   - Output directory structure
   - Which metadata fields are available
   
2. **`shared` section**: Only include fields that have IDENTICAL values across all providers
   - Typically just `description`
   - Values are copied exactly to each provider's output

3. **Provider sections**: Each provider has its own section (`claude`, `opencode`)
   - Must include `enabled: true` to participate
   - Contains provider-specific fields in their exact expected format
   - **No transformations**: Values are output exactly as specified

4. **No `providers` array**: Providers declare participation via their own sections with `enabled` flag

5. **Claude `name` field**: Specified in the `claude` section, not at top level (it's Claude-specific)

## Provider-Specific Field Formats

Different providers expect different formats for the same concepts. Templates specify the exact format each provider needs.

### Tools Format

**Claude** - Comma-separated string with capitalized names:
```yaml
claude:
  tools: "Grep, Glob, LS"
```

**OpenCode** - Object with boolean values:
```yaml
opencode:
  tools:
    grep: true
    glob: true
    list: true
```

**Tool Name Differences:**
- Claude uses `LS`, OpenCode uses `list`
- Otherwise names are typically the same (lowercase for OpenCode, Capitalized for Claude)

### Model Format

**Claude** - Short alias:
```yaml
claude:
  model: sonnet  # or opus, haiku
```

**OpenCode** - Full identifier:
```yaml
opencode:
  model: anthropic/claude-sonnet-4-5
```

## Provider Output Formats

The sync script generates different output formats for each provider:

### Claude Agent Output
```yaml
name: research/codebase-locator
description: The description text
tools: "Grep, Glob, LS"
model: sonnet
```

### Claude Command Output
```yaml
description: The description text
```

### OpenCode Agent Output
```yaml
description: The description text
mode: subagent
model: anthropic/claude-sonnet-4-5
tools:
  grep: true
  glob: true
  list: true
# Optional fields:
# temperature: 0.3
# permission:
#   bash:
#     "*": ask
```

### OpenCode Command Output
```yaml
description: The description text
```

## Advanced OpenCode Features

OpenCode supports additional fields for fine-grained control:

### Mode
```yaml
opencode:
  mode: subagent  # or "primary"
```

### Temperature
```yaml
opencode:
  temperature: 0.3  # Float value
```

### Permission Control
```yaml
opencode:
  permission:
    bash:
      "*": ask       # Ask before running any bash command
      "git*": allow  # Auto-allow git commands
```

### Explicit Tool Disabling
```yaml
opencode:
  tools:
    grep: true
    glob: true
    write: false  # Explicitly disable write tool
```

## Examples

### Example 1: Research Agent with Full Features

```yaml
---
type: agent

shared:
  description: Locates files, directories, and components relevant to a feature or task

claude:
  enabled: true
  name: research/codebase-locator
  tools: "Grep, Glob, LS"
  model: sonnet

opencode:
  enabled: true
  mode: subagent
  model: anthropic/claude-sonnet-4-5
  tools:
    grep: true
    glob: true
    list: true
---

[Agent instructions here]
```

### Example 2: Simple Command

```yaml
---
type: command

shared:
  description: Create git commits with user approval

claude:
  enabled: true

opencode:
  enabled: true
---

[Command instructions here]
```

### Example 3: OpenCode-Only Agent with Advanced Features

```yaml
---
type: agent

shared:
  description: Specialized agent for data analysis tasks

claude:
  enabled: false

opencode:
  enabled: true
  mode: primary
  model: anthropic/claude-sonnet-4-5
  temperature: 0.3
  tools:
    read: true
    bash: true
    write: false
  permission:
    bash:
      "rm*": ask
      "git*": allow
      "*": ask
---

[Agent instructions here]
```

### Example 4: Claude-Only Agent

```yaml
---
type: agent

shared:
  description: Claude-specific debugging agent

claude:
  enabled: true
  name: debug/error-analyzer
  tools: "Read, Grep"
  model: opus

opencode:
  enabled: false
---

[Agent instructions here]
```

## Creating New Templates

1. **Choose type**: Decide if this is an `agent` or `command`
2. **Write shared description**: Start with the description that applies to all providers
3. **Add provider sections**: For each provider you want to support:
   - Set `enabled: true`
   - Add provider-specific fields in their exact format
4. **Write body content**: Add the prompt/instructions below the frontmatter
5. **Validate**: Ensure YAML frontmatter is valid and required fields are present

## File Organization

```
templates/
├── agents/
│   ├── research/        # Research and exploration agents
│   ├── brainstorm/      # Creative and planning agents
│   ├── go/              # Go language specialists
│   └── python/          # Python language specialists
└── commands/
    └── g/               # Git-related commands
```

Place templates in the appropriate subdirectory based on their function and type.
