/**
 * Minimal Streamable-HTTP MCP server, for integration tests.
 *
 * The client POSTs JSON-RPC and expects `application/json` back (SSE is also
 * accepted by the client, but JSON keeps the fixture small). `GET /mcp`
 * answers 405, which the client reads as "no server-to-client stream".
 */

import { createServer } from 'node:http';

const TOOLS = [
  {
    name: 'http_echo',
    description: 'Echo the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function reply(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/** Start on an ephemeral loopback port. */
export async function startFixtureServer() {
  const calls = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/mcp') {
      response.writeHead(405, { allow: 'POST, DELETE' });
      response.end();
      return;
    }
    if (request.method === 'DELETE' && request.url === '/mcp') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404);
      response.end();
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }

      if (message.method !== undefined) calls.push(message.method);

      if (message.method === 'initialize') {
        reply(response, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'piwork-http-fixture', version: '1.0.0' },
          },
        });
        return;
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === 'tools/list') {
        reply(response, { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
        return;
      }
      if (message.method === 'tools/call') {
        reply(response, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `pong:${message.params?.arguments?.text ?? ''}` }] },
        });
        return;
      }
      if (message.id !== undefined) {
        reply(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
        return;
      }
      response.writeHead(202);
      response.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
