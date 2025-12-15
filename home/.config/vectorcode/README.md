# VectorCode

[https://github.com/Davidyz/VectorCode](https://github.com/Davidyz/VectorCode)

VectorCode is integrated as a semantic code search and analysis tool with ChromaDB persistence, providing AI-assisted code understanding capabilities across multiple development environments (Claude Code, Gemini, and OpenCode) through MCP (Model Context Protocol) server integration.

## Configuration Files

### `config.json`

Points VectorCode client to local ChromaDB instance:

```json
{
  "db_url": "http://127.0.0.1:9898"
}
```

### `docker-compose.yml`

Docker service setup for ChromaDB:

- Service: `vectorcode_chromadb` using `chromadb/chroma:0.6.3` image
- Port mapping: Host port 9898 to container port 8000
- Persistence: Volume mount `~/.local/share/vectorcode/chromadb:/lekkerlocation`
- Environment: `PERSIST_DIRECTORY=/lekkerlocation`

### `vectorcode.exclude`

File exclusion patterns:

- Excludes `.vectorcode/` directories from indexing
- Respects `.gitignore` by default

## Usage

### Service Management

Use the just commands from the global justfile:

```bash
# Start ChromaDB container (idempotent)
# This is a performance enhancement. The container uses the same db location as
# the default vectorcode configs, so it falls back gracefully, but with startup
# overhead
just -g vectorcode-db-start

# Stop ChromaDB container gracefully
just -g vectorcode-db-stop
```

### Neovim Integration

VectorCode automatically indexes files when:

- Files are written (`BufWritePost`)
- Entering insert mode (`InsertEnter`)
- Files are read (`BufReadPost`)

Configuration includes:

- 10ms debounce delay
- Async operations with 5000ms timeout
- Context-aware queries with surrounding lines

### MCP Integration

VectorCode provides semantic code search capabilities to AI agents through MCP tools:

#### Supported Agents

- **Claude Code**: Unified `mcpServers` format in `~/.claude.json`
- **Gemini**: Unified `mcpServers` format in `home/.gemini/settings.json`
- **OpenCode**: Array-based format with `type` field in `home/.config/opencode/opencode.json`

### Data Persistence

Embeddings are stored persistently in `~/.local/share/vectorcode/chromadb/` through Docker volume mounting, ensuring code context is preserved across container restarts.

## Architecture

1. **Container Startup**: ChromaDB launches with persistent volume
2. **File Indexing**: Neovim triggers VectorCode on file modifications (debounced)
3. **MCP Connection**: VectorCode MCP server connects to ChromaDB at port 9898
4. **Agent Queries**: AI agents use MCP tools for semantic code search
5. **Persistence**: Embeddings stored in local filesystem

## Configuration Management

MCP server configurations are centrally managed in `scripts/mcp/mcp-servers.json` and automatically distributed to all agent configs via `scripts/mcp/set-mcp-servers.py`.

