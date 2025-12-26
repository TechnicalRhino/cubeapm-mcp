#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Configuration from environment variables
const CUBEAPM_HOST = process.env.CUBEAPM_HOST || "localhost";
const CUBEAPM_QUERY_PORT = process.env.CUBEAPM_QUERY_PORT || "3140";
const CUBEAPM_INGEST_PORT = process.env.CUBEAPM_INGEST_PORT || "3130";

const queryBaseUrl = `http://${CUBEAPM_HOST}:${CUBEAPM_QUERY_PORT}`;
const ingestBaseUrl = `http://${CUBEAPM_HOST}:${CUBEAPM_INGEST_PORT}`;

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
  "Query logs from CubeAPM using LogsQL syntax. Returns log entries matching the query.",
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
  "Execute an instant query against CubeAPM metrics at a single point in time. Uses PromQL-compatible syntax.",
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
  "Execute a range query against CubeAPM metrics over a time range. Returns time series data.",
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
  "Search for traces in CubeAPM matching the specified criteria. Returns trace snippets with key spans.",
  {
    query: z.string().optional().describe("The traces search query"),
    env: z.string().optional().describe("Environment name to filter by"),
    service: z.string().optional().describe("Service name to filter by"),
    start: z.string().describe("Start timestamp in RFC3339 format or Unix seconds"),
    end: z.string().describe("End timestamp in RFC3339 format or Unix seconds"),
    limit: z.number().optional().default(20).describe("Maximum number of traces to return"),
  },
  async ({ query, env, service, start, end, limit }) => {
    const params = new URLSearchParams({ start, end, limit: String(limit) });
    if (query) params.append("query", query);
    if (env) params.append("env", env);
    if (service) params.append("service", service);

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
