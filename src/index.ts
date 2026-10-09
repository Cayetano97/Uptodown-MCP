#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { UptodownClient } from './client.js';
import { FILE_ROOT_ENV, resolveFileRoot } from './file-root.js';
import { registerAccountTools } from './tools/account.js';
import { registerAppTools } from './tools/apps.js';
import { registerDescriptionTools } from './tools/descriptions.js';
import { registerFileTools } from './tools/files.js';
import { registerMediaTools } from './tools/media.js';
import { registerCommentTools } from './tools/comments.js';
import { registerStatsTools } from './tools/stats.js';

const SERVER_NAME = 'uptodown-mcp';
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Unofficial Uptodown Developers Console tools. Auth is configured outside the tools:',
  'either run "npm run login" once in a browser (Google, GitHub or email login) to capture a',
  'session, or set UPTODOWN_EMAIL and UPTODOWN_PASSWORD. Without either, every tool answers',
  'with setup instructions instead of running. Start with whoami, then list_my_apps for your own',
  'apps (list_apps shows the console app table instead, which can be a review queue).',
].join(' ');

/**
 * Builds a fresh server instance.
 *
 * `serveStdio` pins exactly one instance per connection and picks the protocol era
 * from the opening message, so both the legacy `initialize` handshake (what most
 * MCP clients, including OpenCode, send) and the modern era work off one factory.
 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const client = new UptodownClient();

  registerAccountTools(server, client);
  registerAppTools(server, client);
  registerDescriptionTools(server, client);
  registerFileTools(server, client);
  registerMediaTools(server, client);
  registerCommentTools(server, client);
  registerStatsTools(server, client);

  return server;
}

serveStdio(() => buildServer(), { legacy: 'serve' });

// stdout is reserved for the stdio JSON-RPC transport: diagnostics go to stderr.
process.stderr.write(`[${SERVER_NAME}] listening on stdio\n`);
if (resolveFileRoot() === null) {
  process.stderr.write(
    `${SERVER_NAME}: local upload paths are unrestricted; set ${FILE_ROOT_ENV} to restrict them to a directory.\n`,
  );
}
