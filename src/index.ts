#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Configuration from environment variables
// CUBEAPM_URL takes precedence - use full URL like https://prod-cube.example.com
// Falls back to building URL from CUBEAPM_HOST + ports for backward compatibility
const CUBEAPM_URL = process.env.CUBEAPM_URL;
const CUBEAPM_HOST = process.env.CUBEAPM_HOST || "localhost";
const CUBEAPM_QUERY_PORT = process.env.CUBEAPM_QUERY_PORT || "3140";
const CUBEAPM_INGEST_PORT = process.env.CUBEAPM_INGEST_PORT || "3130";

// If CUBEAPM_URL is provided, use it directly (removes trailing slash if present)
// Otherwise build from host:port
const queryBaseUrl = CUBEAPM_URL
  ? CUBEAPM_URL.replace(/\/$/, '')
  : `http://${CUBEAPM_HOST}:${CUBEAPM_QUERY_PORT}`;
const ingestBaseUrl = CUBEAPM_URL
  ? CUBEAPM_URL.replace(/\/$/, '')
  : `http://${CUBEAPM_HOST}:${CUBEAPM_INGEST_PORT}`;

// Create the MCP server
const server = new McpServer({
  name: "cubeapm-mcp",
  version: "1.0.0",
});

// ============================================
// LOGS APIs
// ============================================

server.tool(
  "query_logs",
  `Query logs from CubeAPM using LogsQL syntax (VictoriaLogs compatible). Returns log entries matching the query.

IMPORTANT - Log Label Discovery:
- Labels vary by source! Use "*" query first to discover available labels
- Lambda logs use: faas.name, faas.arn, env, aws.lambda_request_id
- Service logs may use: service_name, level, host
- NOT all sources have "service_name" - check the _stream field in results

LogsQL Query Syntax:
- Wildcard (discover labels): *
- Stream filters: {faas.name="my-lambda-prod"}
- Text search: {faas.name="webhook-lambda-prod"} AND "error"
- Regex match: {faas.name=~".*-prod"}
- Negation: {faas.name!="unwanted-service"}
- Combine filters: {env="UNSET", faas.name=~".*-lambda.*"}

PIPE OPERATORS — chain after query with "|":
  | copy src_field AS dst_field       — copy field value
  | drop field1, field2               — remove fields from output
  | extract_regexp "(?P<name>regex)"  — extract fields via named capture groups
  | join by (field) (...subquery...)   — join with subquery results
  | keep field1, field2               — keep only specified fields
  | limit N                           — return at most N results
  | math result = field1 + field2     — compute derived fields (+, -, *, /, %)
  | rename src AS dst                 — rename a field
  | replace (field, "old", "new")     — replace substring in field
  | replace_regexp (field, "re", "replacement") — regex replacement
  | sort by (field) [asc|desc]        — sort results
  | stats <func> as alias [by (group_fields)] — aggregate results
  | unpack_json                       — extract fields from JSON log body

STATS FUNCTIONS (use with | stats pipe):
  avg(field)            — arithmetic mean
  count()               — total number of matching entries
  count_empty(field)    — count entries where field is empty
  count_uniq(field)     — count distinct values
  max(field)            — maximum value
  median(field)         — median (50th percentile)
  min(field)            — minimum value
  quantile(p, field)    — p-th quantile (e.g., quantile(0.95, duration))
  sum(field)            — sum of values

Example queries:
- All logs (discover structure): *
- Lambda logs: {faas.name="webhook-lambda-prod"}
- Search errors: {faas.name=~".*"} AND "error"
- By environment: {env="production"}
- Count errors per function: {faas.name=~".*"} AND "error" | stats count() as error_count by (faas.name)
- Top 10 slowest: {service_name="my-service"} | sort by (duration) desc | limit 10`,
  {
    query: z.string().describe("The log search query including stream filters (LogsQL syntax)"),
    start: z.string().describe("Start time in RFC3339 format (e.g., 2024-01-01T00:00:00Z) or Unix timestamp in seconds"),
    end: z.string().describe("End time in RFC3339 format or Unix timestamp in seconds"),
    limit: z.number().optional().default(100).describe("Maximum log entries to return (default: 100)"),
  },
  async ({ query, start, end, limit }) => {
    const params = new URLSearchParams({
      query,
      start,
      end,
      limit: String(limit),
    });

    const response = await fetch(`${queryBaseUrl}/api/logs/select/logsql/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error querying logs: ${response.status} ${response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    const text = await response.text();
    return {
      content: [
        {
          type: "text" as const,
          text: text || "No logs found matching the query",
        },
      ],
    };
  }
);

// ============================================
// METRICS APIs
// ============================================

server.tool(
  "query_metrics_instant",
  `Execute an instant query against CubeAPM metrics at a single point in time. Uses PromQL-compatible syntax (VictoriaMetrics flavor).

IMPORTANT - CubeAPM Metric Naming Conventions:
- Metrics use "cube_apm_" prefix (e.g., cube_apm_calls_total, cube_apm_latency_bucket)
- Service label is "service" (NOT "server" or "service_name")
- Common labels: env, service, span_kind (server|client|consumer|producer), status_code, http_code

HISTOGRAM QUERIES (P50, P90, P95, P99):
- CubeAPM uses VictoriaMetrics-style histograms with "vmrange" label (NOT Prometheus "le" buckets)
- Use histogram_quantiles() function instead of histogram_quantile()
- Syntax: histogram_quantiles("phi", 0.95, sum by (vmrange) (increase(cube_apm_latency_bucket{...}[5m])))
- Latency values are returned in SECONDS (0.05 = 50ms)

Example queries:
- P95 latency: histogram_quantiles("phi", 0.95, sum by (vmrange, service) (increase(cube_apm_latency_bucket{service="MyService", span_kind="server"}[5m])))
- Error rate: sum by (service) (increase(cube_apm_calls_total{status_code="ERROR"}[1h])) / sum by (service) (increase(cube_apm_calls_total[1h])) * 100
- List services: count by (service) (cube_apm_calls_total{env="UNSET"})
- Request count: sum by (service) (increase(cube_apm_calls_total{span_kind=~"server|consumer"}[1h]))`,
  {
    query: z.string().describe("The metrics query expression (PromQL syntax)"),
    time: z.string().describe("Evaluation timestamp in RFC3339 format or Unix timestamp in seconds"),
    step: z.number().optional().describe("Time window in seconds for processing data"),
  },
  async ({ query, time, step }) => {
    const params = new URLSearchParams({ query, time });
    if (step) params.append("step", String(step));

    const response = await fetch(`${queryBaseUrl}/api/metrics/api/v1/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error querying metrics: ${response.status} ${response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    const data = await response.json();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "query_metrics_range",
  `Execute a range query against CubeAPM metrics over a time range. Returns time series data. Uses PromQL-compatible syntax (VictoriaMetrics flavor).

IMPORTANT - CubeAPM Metric Naming Conventions:
- Metrics use "cube_apm_" prefix (e.g., cube_apm_calls_total, cube_apm_latency_bucket)
- Service label is "service" (NOT "server" or "service_name")
- Common labels: env, service, span_kind (server|client|consumer|producer), status_code, http_code

HISTOGRAM QUERIES (P50, P90, P95, P99):
- CubeAPM uses VictoriaMetrics-style histograms with "vmrange" label (NOT Prometheus "le" buckets)
- Use histogram_quantiles() function instead of histogram_quantile()
- Syntax: histogram_quantiles("phi", 0.95, sum by (vmrange, service) (increase(cube_apm_latency_bucket{...}[5m])))
- Latency values are returned in SECONDS (0.05 = 50ms)

Example range query for P95 over time:
histogram_quantiles("phi", 0.95, sum by (vmrange, service) (increase(cube_apm_latency_bucket{service="MyService", span_kind="server"}[5m])))`,
  {
    query: z.string().describe("The metrics query expression (PromQL syntax)"),
    start: z.string().describe("Start timestamp in RFC3339 format or Unix timestamp"),
    end: z.string().describe("End timestamp in RFC3339 format or Unix timestamp"),
    step: z.number().describe("Resolution step width in seconds"),
  },
  async ({ query, start, end, step }) => {
    const params = new URLSearchParams({
      query,
      start,
      end,
      step: String(step),
    });

    const response = await fetch(`${queryBaseUrl}/api/metrics/api/v1/query_range`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error querying metrics range: ${response.status} ${response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    const data = await response.json();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }
);

// ============================================
// TRACES APIs
// ============================================

server.tool(
  "search_traces",
  `Search for traces in CubeAPM matching the specified criteria. Returns trace snippets with key spans.

IMPORTANT - Required Parameters:
- query, env, service, start, end are ALL REQUIRED by CubeAPM API
- Use query="*" for wildcard search
- Use env="UNSET" if environment is not configured
- Service names are case-sensitive (e.g., "Kratos-Prod" not "kratos")

TRACE QUERY SYNTAX:
The query parameter supports pipe syntax similar to LogsQL:
  {stream_selector} | pipe1 | pipe2

Stream selectors filter spans:
  {service="Kratos-Prod"}
  {service="Kratos-Prod", span_kind="server"}
  {http_code=~"5.."}

PIPE OPERATORS — same as LogsQL pipes:
  | copy, | drop, | extract_regexp, | join, | keep, | limit,
  | math, | rename, | replace, | replace_regexp, | sort,
  | stats <func> as alias [by (group_fields)], | unpack_json

STATS FUNCTIONS (for aggregate trace analysis):
  avg(field)            — arithmetic mean
  count()               — total matching spans
  count_uniq(field)     — distinct values
  max(field)            — maximum value
  median(field)         — median value
  min(field)            — minimum value
  quantile(p, field)    — p-th quantile (e.g., quantile(0.95, duration))
  sum(field)            — sum of values

IMPORTANT: Duration in traces is in MILLISECONDS.
IMPORTANT: "p95" is NOT a valid function — use quantile(0.95, duration).

Example queries:
  Wildcard: query="*"
  P95 latency: query='{service="Kratos-Prod", span_kind="server"} | stats quantile(0.95, duration) as p95_latency'
  Error count by endpoint: query='{service="Kratos-Prod", status_code="ERROR"} | stats count() as errors by (http_route)'
  Slow spans: query='{service="Kratos-Prod"} | sort by (duration) desc | limit 20'

Optional filters (applied in addition to query):
- spanKind: server, client, consumer, producer
- sortBy: duration (to find slow traces)

To discover available service names, first query metrics:
count by (service) (cube_apm_calls_total{env="UNSET"})`,
  {
    query: z.string().default("*").describe("The traces search query (use * for wildcard)"),
    env: z.string().default("UNSET").describe("Environment name (use UNSET if not configured)"),
    service: z.string().describe("Service name to filter by (REQUIRED, case-sensitive)"),
    start: z.string().describe("Start timestamp in RFC3339 format or Unix seconds"),
    end: z.string().describe("End timestamp in RFC3339 format or Unix seconds"),
    limit: z.number().optional().default(20).describe("Maximum number of traces to return"),
    spanKind: z.string().optional().describe("Filter by span kind: server, client, consumer, producer"),
    sortBy: z.string().optional().describe("Sort results by: duration"),
  },
  async ({ query, env, service, start, end, limit, spanKind, sortBy }) => {
    // Generate a random index value for the API call
    const index = Math.random().toString(36).substring(2, 15);

    const params = new URLSearchParams({
      query,
      env,
      service,
      start,
      end,
      limit: String(limit),
      index
    });
    if (spanKind) params.append("spanKind", spanKind);
    if (sortBy) params.append("sortBy", sortBy);

    const response = await fetch(
      `${queryBaseUrl}/api/traces/api/v1/search?${params.toString()}`,
      { method: "GET" }
    );

    if (!response.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error searching traces: ${response.status} ${response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    const data = await response.json();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get_trace",
  "Fetch a complete trace by its ID from CubeAPM. Returns all spans in the trace with full details.",
  {
    trace_id: z.string().describe("The hex-encoded trace ID to fetch"),
    start: z.string().describe("Start timestamp in RFC3339 format or Unix seconds"),
    end: z.string().describe("End timestamp in RFC3339 format or Unix seconds"),
  },
  async ({ trace_id, start, end }) => {
    const params = new URLSearchParams({ start, end });

    const response = await fetch(
      `${queryBaseUrl}/api/traces/api/v1/traces/${trace_id}?${params.toString()}`,
      { method: "GET" }
    );

    if (!response.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching trace: ${response.status} ${response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    const data = await response.json();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }
);

// ============================================
// INGESTION APIs (for sending data to CubeAPM)
// ============================================

server.tool(
  "ingest_metrics_prometheus",
  "Send metrics to CubeAPM in Prometheus text exposition format.",
  {
    metrics: z.string().describe("Metrics data in Prometheus text exposition format"),
  },
  async ({ metrics }) => {
    const response = await fetch(`${ingestBaseUrl}/api/metrics/v1/save`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: metrics,
    });

    if (!response.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error ingesting metrics: ${response.status} ${response.statusText}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: "Metrics ingested successfully",
        },
      ],
    };
  }
);

// ============================================
// PROMPTS - Pre-defined templates for common tasks
// ============================================

server.prompt(
  "investigate-service",
  "Investigate issues with a specific service - checks errors, latency, and recent traces",
  {
    service: z.string().describe("The service name to investigate (case-sensitive)"),
    timeRange: z.string().optional().default("1h").describe("Time range to look back (e.g., 1h, 6h, 24h)"),
  },
  async ({ service, timeRange }) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please investigate the ${service} service for the last ${timeRange}:

1. First, check the error rate using metrics:
   - Query: sum(increase(cube_apm_calls_total{service="${service}", status_code="ERROR"}[${timeRange}])) / sum(increase(cube_apm_calls_total{service="${service}"}[${timeRange}])) * 100

2. Check P95 latency:
   - Query: histogram_quantiles("phi", 0.95, sum by (vmrange) (increase(cube_apm_latency_bucket{service="${service}", span_kind="server"}[5m])))

3. Search for error traces:
   - Use search_traces with service="${service}", query="status_code=ERROR"

4. Check recent logs if available:
   - Query logs with {service_name="${service}"} or discover labels first with *

Summarize any issues found and provide recommendations.`,
          },
        },
      ],
    };
  }
);

server.prompt(
  "check-latency",
  "Check P50, P95, and P99 latency percentiles for a service",
  {
    service: z.string().describe("The service name (case-sensitive)"),
  },
  async ({ service }) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Check the latency percentiles for ${service} service:

Use query_metrics_instant with these queries:

1. P50 (median):
   histogram_quantiles("phi", 0.5, sum by (vmrange, service) (increase(cube_apm_latency_bucket{service="${service}", span_kind="server"}[5m])))

2. P95:
   histogram_quantiles("phi", 0.95, sum by (vmrange, service) (increase(cube_apm_latency_bucket{service="${service}", span_kind="server"}[5m])))

3. P99:
   histogram_quantiles("phi", 0.99, sum by (vmrange, service) (increase(cube_apm_latency_bucket{service="${service}", span_kind="server"}[5m])))

Note: Latency values are in SECONDS (multiply by 1000 for milliseconds).

Present the results in a clear table format.`,
          },
        },
      ],
    };
  }
);

server.prompt(
  "find-slow-traces",
  "Find the slowest traces for a service to identify performance bottlenecks",
  {
    service: z.string().describe("The service name (case-sensitive)"),
    minDuration: z.string().optional().default("1s").describe("Minimum duration to filter (e.g., 500ms, 1s, 2s)"),
  },
  async ({ service, minDuration }) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Find slow traces for ${service} service (minimum duration: ${minDuration}):

1. Search for traces using search_traces with:
   - service: "${service}"
   - sortBy: "duration"
   - spanKind: "server"
   - limit: 10

2. For the slowest trace found, use get_trace to fetch the full trace details

3. Analyze the trace waterfall to identify:
   - Which span took the longest
   - Any external dependencies causing delays
   - Database queries or API calls that are slow

Provide a summary of performance bottlenecks and recommendations.`,
          },
        },
      ],
    };
  }
);

// ============================================
// RESOURCES - Expose CubeAPM data as readable resources
// ============================================

server.resource(
  "config",
  "cubeapm://config",
  {
    description: "Current CubeAPM connection configuration",
    mimeType: "application/json",
  },
  async () => {
    return {
      contents: [
        {
          uri: "cubeapm://config",
          mimeType: "application/json",
          text: JSON.stringify({
            queryUrl: queryBaseUrl,
            ingestUrl: ingestBaseUrl,
            usingFullUrl: !!CUBEAPM_URL,
            host: CUBEAPM_HOST,
            queryPort: CUBEAPM_QUERY_PORT,
            ingestPort: CUBEAPM_INGEST_PORT,
          }, null, 2),
        },
      ],
    };
  }
);

server.resource(
  "query-patterns",
  "cubeapm://query-patterns",
  {
    description: "CubeAPM-specific query patterns and naming conventions",
    mimeType: "text/markdown",
  },
  async () => {
    return {
      contents: [
        {
          uri: "cubeapm://query-patterns",
          mimeType: "text/markdown",
          text: `# CubeAPM Query Patterns — Full Reference

## Metrics (PromQL / MetricsQL)

### Naming Conventions
- Prefix: \`cube_apm_*\` (e.g., cube_apm_calls_total, cube_apm_latency_bucket)
- Service label: \`service\` (NOT "server" or "service_name")
- Common labels: env, service, span_kind, status_code, http_code

### Histogram Queries (Percentiles)
CubeAPM uses VictoriaMetrics-style histograms with \`vmrange\` label (NOT Prometheus \`le\` buckets):

\`\`\`promql
# ✅ Correct — use histogram_quantiles() with vmrange
histogram_quantiles("phi", 0.95, sum by (vmrange, service) (
  increase(cube_apm_latency_bucket{service="MyService", span_kind="server"}[5m])
))

# ❌ Wrong — standard Prometheus syntax won't work
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_bucket[5m])))
\`\`\`

Latency values are in SECONDS (0.05 = 50ms).

---

## Logs (LogsQL)

### Stream Selectors
- \`*\` — wildcard, discover all labels
- \`{faas.name="my-function"}\` — exact match
- \`{faas.name=~".*-prod"}\` — regex match
- \`{faas.name!="unwanted"}\` — negation
- \`{env="production", faas.name=~".*"}\` — combine filters

### Text Filters
- \`{stream} AND "error"\` — text search
- \`{stream} AND "timeout" AND NOT "retry"\` — boolean operators

### Pipe Operators
Chain after query with \`|\`:

| Pipe | Syntax | Description |
|------|--------|-------------|
| copy | \`copy src AS dst\` | Copy field value |
| drop | \`drop field1, field2\` | Remove fields from output |
| extract_regexp | \`extract_regexp "(?P<name>re)"\` | Extract via named capture groups |
| join | \`join by (field) (...subquery...)\` | Join with subquery |
| keep | \`keep field1, field2\` | Keep only specified fields |
| limit | \`limit N\` | Return at most N results |
| math | \`math result = f1 + f2\` | Arithmetic (+, -, *, /, %) |
| rename | \`rename src AS dst\` | Rename a field |
| replace | \`replace (field, "old", "new")\` | Substring replacement |
| replace_regexp | \`replace_regexp (field, "re", "repl")\` | Regex replacement |
| sort | \`sort by (field) [asc/desc]\` | Sort results |
| stats | \`stats <func> as alias [by (fields)]\` | Aggregate results |
| unpack_json | \`unpack_json\` | Extract fields from JSON body |

### Stats Functions
Used with \`| stats\` pipe:

| Function | Description |
|----------|-------------|
| \`avg(field)\` | Arithmetic mean |
| \`count()\` | Total matching entries |
| \`count_empty(field)\` | Entries where field is empty |
| \`count_uniq(field)\` | Distinct values |
| \`max(field)\` | Maximum value |
| \`median(field)\` | Median (50th percentile) |
| \`min(field)\` | Minimum value |
| \`quantile(p, field)\` | p-th quantile (e.g., quantile(0.95, duration)) |
| \`sum(field)\` | Sum of values |

### Example Log Queries
\`\`\`logsql
# Discover labels
*

# Count errors per Lambda function
{faas.name=~".*"} AND "error" | stats count() as errors by (faas.name)

# Top 10 slowest requests
{service_name="my-service"} | sort by (duration) desc | limit 10
\`\`\`

---

## Traces

### Query Syntax
Trace queries use the same pipe syntax:
\`{stream_selector} | pipe1 | pipe2\`

### Stream Selectors
- \`{service="Kratos-Prod"}\`
- \`{service="Kratos-Prod", span_kind="server"}\`
- \`{http_code=~"5.."}\`

### Important Notes
- query, env, service are REQUIRED parameters
- Duration is in MILLISECONDS (not seconds like metrics)
- \`p95\` is NOT a valid function — use \`quantile(0.95, duration)\`
- Use \`sortBy=duration\` param to find slow traces
- Filter by spanKind: server, client, consumer, producer

### Example Trace Queries
\`\`\`
# P95 latency for a service
{service="Kratos-Prod", span_kind="server"} | stats quantile(0.95, duration) as p95_ms

# Error count by endpoint
{service="Kratos-Prod", status_code="ERROR"} | stats count() as errors by (http_route)

# Slowest spans
{service="Kratos-Prod"} | sort by (duration) desc | limit 20
\`\`\`
`,
        },
      ],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CubeAPM MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
