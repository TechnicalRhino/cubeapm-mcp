# CubeAPM MCP Server

[![npm version](https://badge.fury.io/js/cubeapm-mcp.svg)](https://www.npmjs.com/package/cubeapm-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [CubeAPM](https://cubeapm.com) - enabling AI assistants like Claude to query your observability data including traces, metrics, and logs.

## What is this?

This MCP server connects AI assistants (like Claude) to your CubeAPM instance, allowing you to:

- **Query logs** using natural language that gets translated to LogsQL
- **Analyze metrics** with PromQL-compatible queries
- **Search and inspect traces** to debug distributed systems
- **Monitor your services** through conversational interfaces

## Installation

### From NPM (Recommended)

```bash
npm install -g cubeapm-mcp
```

### From Source

```bash
git clone https://github.com/TechnicalRhino/cubeapm-mcp.git
cd cubeapm-mcp
npm install
npm run build
```

## Quick Start

### 1. Configure Claude Code

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "cubeapm": {
      "command": "npx",
      "args": ["-y", "cubeapm-mcp"],
      "env": {
        "CUBEAPM_HOST": "your-cubeapm-server.com"
      }
    }
  }
}
```

### 2. Restart Claude Code

After updating the settings, restart Claude Code to load the MCP server.

### 3. Start Querying

You can now ask Claude questions like:

- *"Show me error logs from the payment-service in the last hour"*
- *"What's the p99 latency for the checkout API?"*
- *"Find traces where duration > 5s in production"*
- *"Get the full trace for trace ID abc123def456"*

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CUBEAPM_HOST` | `localhost` | CubeAPM server hostname or IP |
| `CUBEAPM_QUERY_PORT` | `3140` | Port for querying APIs (traces, metrics, logs) |
| `CUBEAPM_INGEST_PORT` | `3130` | Port for ingestion APIs |

### Example Configurations

**Local Development:**
```json
{
  "mcpServers": {
    "cubeapm": {
      "command": "npx",
      "args": ["-y", "cubeapm-mcp"],
      "env": {
        "CUBEAPM_HOST": "localhost"
      }
    }
  }
}
```

**Production:**
```json
{
  "mcpServers": {
    "cubeapm": {
      "command": "npx",
      "args": ["-y", "cubeapm-mcp"],
      "env": {
        "CUBEAPM_HOST": "cubeapm.internal.company.com",
        "CUBEAPM_QUERY_PORT": "3140"
      }
    }
  }
}
```

## Available Tools

### Logs

| Tool | Description |
|------|-------------|
| `query_logs` | Query logs using LogsQL syntax with time range and limit |

**Parameters:**
- `query` - LogsQL query string (e.g., `{service="api"} error`)
- `start` - Start time (RFC3339 or Unix timestamp)
- `end` - End time (RFC3339 or Unix timestamp)
- `limit` - Maximum entries to return (default: 100)

### Metrics

| Tool | Description |
|------|-------------|
| `query_metrics_instant` | Execute a PromQL query at a single point in time |
| `query_metrics_range` | Execute a PromQL query over a time range |

**Instant Query Parameters:**
- `query` - PromQL expression
- `time` - Evaluation timestamp
- `step` - Optional time window in seconds

**Range Query Parameters:**
- `query` - PromQL expression
- `start` / `end` - Time range
- `step` - Resolution in seconds

### Traces

| Tool | Description |
|------|-------------|
| `search_traces` | Search traces by service, environment, or custom query |
| `get_trace` | Fetch complete trace details by trace ID |

**Search Parameters:**
- `query` - Optional search query
- `env` - Environment filter (e.g., `production`)
- `service` - Service name filter
- `start` / `end` - Time range
- `limit` - Maximum results (default: 20)

**Get Trace Parameters:**
- `trace_id` - Hex-encoded trace ID
- `start` / `end` - Time range to search within

### Ingestion

| Tool | Description |
|------|-------------|
| `ingest_metrics_prometheus` | Send metrics in Prometheus text exposition format |

## Example Queries

### Logs
```
"Find all ERROR logs from auth-service in the last 30 minutes"
"Show me logs containing 'connection refused' from the database service"
"Query logs where trace_id matches xyz123"
```

### Metrics
```
"What's the average request duration for the API gateway?"
"Show me CPU usage for all services over the last 6 hours"
"Graph the error rate for checkout-service with 1-minute resolution"
```

### Traces
```
"Find slow traces (>2s) from the order-service"
"Show me traces with errors in the production environment"
"Get the full waterfall for trace ID abc123"
```

## Development

```bash
# Clone the repository
git clone https://github.com/TechnicalRhino/cubeapm-mcp.git
cd cubeapm-mcp

# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Build for production
npm run build

# Test the build
npm start
```

## How It Works

```
┌─────────────────┐     MCP Protocol     ┌─────────────────┐     HTTP API     ┌─────────────────┐
│  Claude / AI    │◄───────────────────►│  cubeapm-mcp    │◄────────────────►│    CubeAPM      │
│   Assistant     │   (stdio transport)  │   MCP Server    │   (REST calls)   │    Server       │
└─────────────────┘                      └─────────────────┘                  └─────────────────┘
```

The MCP server:
1. Receives tool calls from the AI assistant via stdio
2. Translates them to CubeAPM HTTP API requests
3. Returns formatted results back to the assistant

## Requirements

- **Node.js** 18+
- **CubeAPM** instance (self-hosted or cloud)
- **Claude Code** or any MCP-compatible client

## Related Links

- [CubeAPM Documentation](https://docs.cubeapm.com)
- [CubeAPM HTTP APIs](https://docs.cubeapm.com/http-apis)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Claude Code](https://claude.ai/code)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) file for details.
