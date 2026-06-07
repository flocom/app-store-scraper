/**
 * MCP server builder.
 *
 * Registers every method from the shared registry as an MCP tool. The same
 * builder is used by the stdio entrypoint (Claude Desktop) and by the
 * streamable-HTTP transport mounted on the Express server.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { methods } from './methods.js';

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'app-store-scraper',
    version: '2.0.1',
  });

  for (const def of methods) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.shape,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await def.handler(args);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: 'text', text: `Error in ${def.name}: ${message}` }],
          };
        }
      },
    );
  }

  return server;
}
