#!/usr/bin/env node
'use strict';
// Servidor MCP de ComposeAnything (stdio). Úsalo desde Claude Desktop, Claude Code o cualquier cliente MCP:
//   { "mcpServers": { "composeanything": { "command": "node", "args": ["<ruta>/src/mcp/server.js"] } } }
// Comparte la obra, el perfil y los ajustes con la app de escritorio (carpeta ~/.composeanything).
// IMPORTANTE: stdout es el canal del protocolo; todo el registro va a stderr.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { Session } = require('../core/session');
const { buildTools, callTool } = require('../core/tools');
const { DSL_GUIDE, WORKFLOW } = require('../core/prompt');
const pkg = require('../../package.json');

function createServer(session = new Session()) {
  const tools = buildTools(session);
  const server = new Server(
    { name: 'composeanything', version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions: `ComposeAnything compone, edita y transcribe música en MuseScore.\n\n${DSL_GUIDE}\n\n${WORKFLOW}\n\nSi el usuario tiene un modo de trabajo "paso a paso", respeta el campo "next" de score_write: resume y pregunta antes de seguir. Lee el perfil de gustos con profile_get al empezar una obra nueva.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await callTool(tools, req.params.name, req.params.arguments);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  });
  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('[composeanything] servidor MCP listo (stdio)');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createServer };
