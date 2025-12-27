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
| `CUBEAPM_URL` | - | Full URL to CubeAPM (e.g., `https://cube.example.com`). Takes precedence over HOST/PORT settings. |
| `CUBEAPM_HOST` | `localhost` | CubeAPM server hostname or IP (used if CUBEAPM_URL not set) |
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

**Production (with full URL):**
```json
{
  "mcpServers": {
    "cubeapm": {
      "command": "npx",
      "args": ["-y", "cubeapm-mcp"],
      "env": {
        "CUBEAPM_URL": "https://cubeapm.internal.company.com"
      }
    }
  }
}
```

**Production (with host/port):**
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

## CubeAPM Query Patterns

### Metrics Naming Conventions

CubeAPM uses specific naming conventions that differ from standard OpenTelemetry:

| What | CubeAPM Convention |
|------|-------------------|
| Metric prefix | `cube_apm_*` (e.g., `cube_apm_calls_total`, `cube_apm_latency_bucket`) |
| Service label | `service` (NOT `server` or `service_name`) |
| Common labels | `env`, `service`, `span_kind`, `status_code`, `http_code` |

### Histogram Queries (P50, P90, P95, P99)

CubeAPM uses **VictoriaMetrics-style histograms** with `vmrange` labels instead of Prometheus `le` buckets:

```promql
# ✅ Correct - Use histogram_quantiles() with vmrange
histogram_quantiles("phi", 0.95, sum by (vmrange, service) (
  increase(cube_apm_latency_bucket{service="MyService", span_kind="server"}[5m])
))

# ❌ Wrong - Standard Prometheus syntax won't work
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_bucket[5m])))
```

> **Note:** Latency values are returned in **seconds** (0.05 = 50ms)

### Logs Label Discovery

Log labels vary by source. Use `*` query first to discover available labels:

| Source | Common Labels |
|--------|---------------|
| Lambda functions | `faas.name`, `faas.arn`, `env`, `aws.lambda_request_id` |
| Services | `service_name`, `level`, `host` |

```logsql
# Discover all labels
*

# Lambda function logs
{faas.name="my-lambda-prod"}

# Search with text filter
{faas.name=~".*-prod"} AND "error"
```

## Example Queries

### Logs
```
"Show me logs from webhook-lambda-prod"
"Find all logs containing 'timeout' in the last hour"
"Query logs from Lambda functions in production"
```

### Metrics
```
"What's the P95 latency for Kratos-Prod service?"
"Show me error rate for all services"
"List all available services in CubeAPM"
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
