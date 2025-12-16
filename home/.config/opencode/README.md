# Development Agents for OpenCode

The `./agent` directory contains specialized development agents for OpenCode, including Go, Python, and Brainstorming agents.

## Commands Overview

- `research_codebase` - Research coordinator
- `debug` - Issue investigation
- `create_plan` - Interactive plan creation
- `oneshot_plan` - Quick planning session
- `iterate_plan` - Plan refinement
- `validate_plan` - Plan review
- `implement_plan` - Follow through on approved plans
- `commit` - Git commit creation
- `describe_pr` - PR documentation
- `resume_handoff` / `create_handoff` - Session management

### Agent-Command Relationships

### Research & Analysis Agents

- **codebase-locator** → Used by: `research_codebase`, `create_plan`, `ralph_research`
- **codebase-analyzer** → Used by: `research_codebase`, `create_plan`, `debug`
- **codebase-pattern-finder** → Used by: `create_plan`, `research_codebase`
- **thoughts-locator** → Used by: `research_codebase`, `create_plan`
- **thoughts-analyzer** → Used by: `research_codebase`, `create_plan`
- **web-search-researcher** → Used by: `research_codebase` (when external info needed)

### Core Workflow Patterns

#### Research → Plan → Implement Workflow

See [HumanLayer Workshop](https://github.com/humanlayer/humanlayer/blob/afadcd6032b4238b3ef3462450354f1ae24fd32b/docs/workshop.mdx)

```text
/research_codebase → /create_plan → /implement_plan
     ↓                ↓               ↓
Multiple agents   Interactive     Single agent
in parallel       planning       execution
```

1. Research the codebase

   ```text
   /g/research_codebase
   ```

   then

   ```text
   we are working on the issue in the issue.txt file,
   please read the issue and research the codebase to understand how the system
   works and what files+line numbers are relevant to the issue.

   Do not make an implementation plan or explain how to fix.
   ```

   _The last line deliberately duplicates instruction in the command_

   Reject the research if it's incorrect and refine inputs until it corroborates
   the work to be done

2. Create a plan

   ```text
   /g/create_plan
   ```

   then

   ```text
    we are working on the issue in the issue.txt file,
    we've done the following research: PATH_TO_RESEARCH_OUTPUT.md

    create a plan to [perform task]. [YOUR ADDITIONAL INSTRUCTIONS HERE]

    work back and forth with me, sharing your open questions and phases outline
    before writing the plan
   ```

   _The last line deliberately duplicates instruction in the command_

   Iterate on the plan until happy

3. Implement the plan

   ```text
   /g/implement_plan
   ```

   then

   ```text
    please implement the plan. [YOUR ADDITIONAL INSTRUCTIONS HERE]

    just do phase 1, then update the plan with your progress and await
    further instructions and confirmation of the manual verification steps
   ```

   iterate with new sessions until complete

4. Validate the plan

   once changes are committed, validate the plan

   ```text
   /g/validate_plan
   ```

#### Debugging Workflow

**TODO**: rewrite to be agnostic of humanlayer deps

```text
/debug → (investigation) → /implement_plan (fixes) → /commit
   ↓           ↓                  ↓              ↓
Problem    Parallel agents    Targeted     Commit fixes
analysis   (logs, DB, git)    fixes
```

## Agents Overview

### Research Agents

```text
User: "How does Y work in our codebase?"
→ /research_codebase
  ↳ codebase-locator (find files)
  ↳ codebase-analyzer (understand implementation)
  ↳ thoughts-locator (historical context)
→ Generates research document
```

#### Parallel Research Pattern

`research_codebase` spawns multiple agents simultaneously:

- `codebase-locator` + `codebase-analyzer` + `thoughts-locator`
- Waits for all to complete
- Synthesizes findings into coherent document

#### Sequential Planning Pattern

`create_plan` uses agents sequentially:

1. `codebase-locator` → Find relevant files
2. `codebase-analyzer` → Understand current implementation
3. `thoughts-locator` → Find historical context
4. Interactive refinement with user

### Brainstorming Agents

The brainstorming agents follow a Socratic methodology for software specification development. Based on the [Socratic Coder](https://github.com/0xVar/llm-prompts-socratic/blob/trunk/data/socratic-coder.md) approach, these agents help develop thorough specifications through guided questioning and critical analysis.

#### socratic (Primary Agent)

- **Purpose**: Socratic questioning agent for software specification development
- **Model**: opencode/big-pickle (temperature 0.3)
- **Access**: Full filesystem and bash capabilities
- **Focus**: Asks targeted questions to gather detailed requirements for software ideas

#### critic-subagent (Subagent)

- **Purpose**: Critically analyzes brainstorming results to identify flaws, challenges, and improvement areas
- **Model**: opencode/big-pickle (temperature 0.3)
- **Access**: Full filesystem and bash capabilities
- **Focus**: Technical feasibility, scalability, security, and market fit analysis

#### spec-writer-subagent (Subagent)

- **Purpose**: Compiles brainstorming findings into comprehensive developer-ready specifications
- **Model**: opencode/big-pickle (temperature 0.3)
- **Access**: Full filesystem and bash capabilities
- **Focus**: Creates RFC-like specification documents for immediate implementation

#### Using the Brainstorming Agents

1. **Start with socratic agent**: Switch to the socratic agent and provide your software idea between `<idea>` tags
2. **Answer questions one by one**: The socratic agent will ask targeted questions about functionality, UI, data management, security, etc.
3. **Critical analysis**: Once brainstorming is complete, use `@critic-subagent` to identify potential issues and challenges
4. **Specification creation**: Finally, use `@spec-writer-subagent` to compile everything into a comprehensive specification

The workflow follows the Socratic method of iterative questioning and refinement, ensuring all aspects of the software are thoroughly explored before implementation.

### Go Agents

#### developer (Primary Agent)

- **Purpose**: Main Go development agent for coding, debugging, and optimization
- **Model**: opencode/big-pickle (temperature 0.3)
- **Access**: Full filesystem, restricted bash (go commands and git read-only)
- **Focus**: Standard library solutions, Go best practices

#### pair-programmer (Primary Agent)

- **Purpose**: Go pair programmer focused on best practices and code review
- **Model**: opencode/big-pickle (temperature 0.3)
- **Access**: Read-only filesystem (no write/edit/bash)
- **Focus**: Expert-level Go guidance, code review, and best practices

### Python Agents

#### developer (Primary Agent)

- **Purpose**: Main Python development agent for coding, debugging, and optimization
- **Model**: opencode/big-pickle (temperature 0.3)
- **Access**: Full filesystem, restricted bash (python, pip, poetry commands and git read-only)
- **Focus**: Standard library solutions, PEP 8 compliance, Python best practices

#### planner-subagent (Subagent)

- **Purpose**: Python project planning and architecture
- **Model**: opencode/big-pickle (temperature 0.1)
- **Access**: Read-only filesystem
- **Focus**: Python-based architecture planning and best practices

#### researcher-subagent (Subagent)

- **Purpose**: Python documentation and research
- **Model**: opencode/big-pickle (temperature 0.2)
- **Access**: Web fetch capabilities
- **Focus**: Official Python documentation, PEPs, and best practices

## Usage

### Switching Between Primary Agents

- Use **Tab** key to cycle through primary agents

### Invoking Subagents

- Manual invocation: `@go/planner-subagent`, `@go/researcher-subagent`, `@python/planner-subagent`, `@python/researcher-subagent`, `@brainstorm/critic-subagent`, or `@brainstorm/spec-writer-subagent`
- Automatic invocation based on task requirements

### When to Use Each Agent

**go/developer**: Use for

- Writing Go code
- Debugging Go applications
- Implementing features
- Running tests and builds

**go/pair-programmer**: Use for

- Expert-level Go guidance and code review
- Best practices consultation
- Performance optimization advice
- Architecture review and recommendations

**go/planner-subagent**: Use for

- Go project architecture planning
- Task breakdown and roadmapping
- Design decisions
- Dependency analysis

**go/researcher-subagent**: Use for

- Looking up Go documentation
- Finding standard library examples
- Researching best practices
- Exploring alternative approaches

**python/developer**: Use for

- Writing Python code
- Debugging Python applications
- Implementing features
- Running tests and builds
- Managing dependencies with pip/poetry

**python/planner-subagent**: Use for

- Python project architecture planning
- Task breakdown and roadmapping
- Design decisions following Python conventions
- Dependency analysis and package structure

**python/researcher-subagent**: Use for

- Looking up Python documentation and PEPs
- Finding standard library examples
- Researching Python best practices
- Exploring third-party package alternatives

**socratic**: Use for

- Software specification development through guided questioning
- Requirements gathering and analysis
- Exploring different aspects of software ideas (functionality, UI, data, security, etc.)
- Iterative refinement of project concepts

**critic-subagent**: Use for

- Critical analysis of brainstorming results
- Identifying technical feasibility issues
- Evaluating scalability and security concerns
- Market fit and resource requirement analysis

**spec-writer-subagent**: Use for

- Creating comprehensive specification documents
- Compiling brainstorming findings into developer-ready formats
- Structuring requirements and architecture details
- Generating RFC-like documentation for implementation

## Project-Specific Extensions

To extend these agents for specific projects, create project-specific agents in `.opencode/agent/` directory:

### Brainstorming Project Extension

```markdown
---
description: Socratic specification development for [project-name]
mode: primary
model: opencode/big-pickle
temperature: 0.3
prompt: |
  You are working on the [project-name] project using Socratic methodology.

  Project Context:
  - [Add project-specific details]
  - [Domain-specific requirements]
  - [Technical constraints]
  - [Target users]

  Focus your questions on [project-name] specific aspects while following the Socratic approach.
---
```

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

## Links and resources

- [https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/](https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/)
- [https://www.penguinrandomhouse.com/books/741805/co-intelligence-by-ethan-mollick/](https://www.penguinrandomhouse.com/books/741805/co-intelligence-by-ethan-mollick/)
- [https://princeton-nlp.github.io/SocraticAI/](https://princeton-nlp.github.io/SocraticAI/)
- [humanlayer](https://github.com/humanlayer/humanlayer)
