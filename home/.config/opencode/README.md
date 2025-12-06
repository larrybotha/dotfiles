# Development Agents for OpenCode

The `./agents` directory contains specialized development agents for OpenCode, including Go and Python agents.

## Agents Overview

### Go Agents

#### go-developer (Primary Agent)

- **Purpose**: Main Go development agent for coding, debugging, and optimization
- **Model**: Claude Sonnet (temperature 0.3)
- **Access**: Full filesystem, restricted bash (go commands and git read-only)
- **Focus**: Standard library solutions, Go best practices

#### go-planner (Subagent)

- **Purpose**: Go project planning and architecture
- **Model**: Claude Haiku (temperature 0.1)
- **Access**: Read-only filesystem
- **Focus**: Standard library-based architecture planning

#### go-researcher (Subagent)

- **Purpose**: Go documentation and research
- **Model**: Claude Haiku (temperature 0.2)
- **Access**: Web fetch capabilities
- **Focus**: Official Go documentation and best practices

### Python Agents

#### python-developer (Primary Agent)

- **Purpose**: Main Python development agent for coding, debugging, and optimization
- **Model**: Claude Sonnet (temperature 0.3)
- **Access**: Full filesystem, restricted bash (python, pip, poetry commands and git read-only)
- **Focus**: Standard library solutions, PEP 8 compliance, Python best practices

#### python-planner (Subagent)

- **Purpose**: Python project planning and architecture
- **Model**: Claude Haiku (temperature 0.1)
- **Access**: Read-only filesystem
- **Focus**: Python-based architecture planning and best practices

#### python-researcher (Subagent)

- **Purpose**: Python documentation and research
- **Model**: Claude Haiku (temperature 0.2)
- **Access**: Web fetch capabilities
- **Focus**: Official Python documentation, PEPs, and best practices

## Usage

### Switching Between Primary Agents

- Use **Tab** key to cycle through primary agents
- Current primary agents: build, plan, go-developer, python-developer

### Invoking Subagents

- Manual invocation: `@go-planner`, `@go-researcher`, `@python-planner`, or `@python-researcher`
- Automatic invocation based on task requirements

### When to Use Each Agent

**go-developer**: Use for

- Writing Go code
- Debugging Go applications
- Implementing features
- Running tests and builds

**go-planner**: Use for

- Go project architecture planning
- Task breakdown and roadmapping
- Design decisions
- Dependency analysis

**go-researcher**: Use for

- Looking up Go documentation
- Finding standard library examples
- Researching best practices
- Exploring alternative approaches

**python-developer**: Use for

- Writing Python code
- Debugging Python applications
- Implementing features
- Running tests and builds
- Managing dependencies with pip/poetry

**python-planner**: Use for

- Python project architecture planning
- Task breakdown and roadmapping
- Design decisions following Python conventions
- Dependency analysis and package structure

**python-researcher**: Use for

- Looking up Python documentation and PEPs
- Finding standard library examples
- Researching Python best practices
- Exploring third-party package alternatives

## Project-Specific Extensions

To extend these agents for specific projects, create project-specific agents in `.opencode/agent/` directory:

### Go Project Extension

```markdown
---description: Go development for [project-name]mode: primarymodel: anthropic/claude-sonnet-4-5prompt: |
  You are working on the [project-name] project.

  Project Context:
  - [Add project-specific details]
  - [Key dependencies]
  - [Build commands]
  - [Project structure]

  Build on standard library knowledge with these project-specific patterns.
---
```

### Python Project Extension

```markdown
---description: Python development for [project-name]mode: primarymodel: anthropic/claude-sonnet-4-5prompt: |
  You are working on the [project-name] project.

  Project Context:
  - [Add project-specific details]
  - [Key dependencies]
  - [Build commands]
  - [Project structure]
  - [Python version requirements]

  Build on standard library knowledge with these project-specific patterns.
---
```

## Permissions

### go-developer Bash Access

**Allowed**:

- `go *` (all go commands)
- `git status`, `git diff`, `git log*`

**Requires confirmation**:

- All other bash commands

### python-developer Bash Access

**Allowed**:

- `python *` (all python commands)
- `pip *` (all pip commands)
- `poetry *` (all poetry commands)
- `python -m *` (module execution)
- `git status`, `git diff`, `git log*`

**Requires confirmation**:

- All other bash commands

This ensures safe development while allowing essential language tooling.

## Testing

### Testing Go Agents

Test the Go agents with a simple Go project:

1. Create a new Go project: `go mod init test-project`
2. Switch to go-developer agent (Tab key)
3. Try implementing a simple HTTP server
4. Test with `go run main.go`
5. Use `@go-researcher` to look up documentation
6. Use `@go-planner` to plan project structure

### Testing Python Agents

Test the Python agents with a simple Python project:

1. Create a new Python project: `python -m venv venv && source venv/bin/activate`
2. Switch to python-developer agent (Tab key)
3. Try implementing a simple web API with FastAPI
4. Test with `python main.py`
5. Use `@python-researcher` to look up documentation
6. Use `@python-planner` to plan project structure

## Troubleshooting

If agents don't appear:

1. Restart OpenCode
2. Check file permissions in `~/.config/opencode/agent/`
3. Verify YAML frontmatter is correctly formatted
4. Check OpenCode logs for configuration errors
