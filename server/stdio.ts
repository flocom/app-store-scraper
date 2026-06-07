#!/usr/bin/env node
/**
 * Stdio MCP entrypoint — for local clients such as Claude Desktop.
 *
 * Usage (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "app-store-scraper": {
 *         "command": "npx",
 *         "args": ["tsx", "/abs/path/to/server/stdio.ts"]
 *       }
 *     }
 *   }
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcp.js';

async function main() {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never log to stdout in stdio mode — it corrupts the JSON-RPC stream.
  process.stderr.write('app-store-scraper MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
