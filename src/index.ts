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

Example queries:
- All logs (discover structure): *
- Lambda logs: {faas.name="webhook-lambda-prod"}
- Search errors: {faas.name=~".*"} AND "error"
- By environment: {env="production"}`,
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

Optional filters:
- spanKind: server, client, consumer, producer
- sortBy: duration (to find slow traces)

To discover available service names, first query metrics:
count by (service) (cube_apm_calls_total{env="UNSET"})

Example: Find slow server spans in Shopify-Prod
  query="*", env="UNSET", service="Shopify-Prod", spanKind="server", sortBy="duration"`,
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
    const params = new URLSearchParams({
      query,
      env,
      service,
      start,
      end,
      limit: String(limit)
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
