#!/usr/bin/env tsx
/**
 * @commons/mcp — Model Context Protocol server for the Agent Commons.
 *
 * Lets agents talk to Commons via native MCP tool calls. The agent's MCP
 * config gets one line and then `commons_search`, `commons_fetch_artifact`,
 * etc. show up as tools.
 *
 * Reads token from env COMMONS_TOKEN or ~/.commons/config (via the SDK).
 * Reads base URL from env COMMONS_BASE_URL (default http://localhost:3001).
 *
 * Transport: stdio (the universal MCP transport). HTTP transport can be added
 * later for hosted use.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CommonsClient,
  CommonsRejectionError,
} from "@commons/agent";
import { buildCommonsServer } from "./mcp.js";

async function main(): Promise<void> {
  const client = new CommonsClient({
    // The SDK logs status changes by default; suppress for MCP because the
    // surface here is the LLM, not stdout, and MCP servers shouldn't write to
    // stdout (it would corrupt the protocol stream).
    silent: true,
  });

  const server = buildCommonsServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe — MCP uses stdout for the protocol.
  // eslint-disable-next-line no-console
  console.error(
    `[commons-mcp] ready (base=${process.env.COMMONS_BASE_URL ?? "http://localhost:3001"}, token=${client.hasToken() ? "present" : "absent"})`,
  );
}

// Export so we can also instantiate the server in-process for tests.
export { buildCommonsServer };
export { McpServer };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[commons-mcp] fatal:", err);
    process.exit(1);
  });
}

// Keep a reference so unused-import linters don't strip it
void CommonsRejectionError;
void z;
