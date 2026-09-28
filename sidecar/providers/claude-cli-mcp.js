#!/usr/bin/env node
/* sidecar/providers/claude-cli-mcp.js — the tool CATALOG half of the claude-cli adapter.

   A minimal stdio MCP server (newline-delimited JSON-RPC, Node core only) that advertises StarNet's tool schemas
   to a `claude -p` child so Claude can call them natively. It deliberately NEVER executes anything: tools/call is
   left unanswered. The adapter (claude-cli.js) watches the child's stream-json output, lifts each tool_use block
   into a HarnessEvent, and ends the child — StarNet's own loop then runs the tool through its normal consent +
   execution path, exactly as it would for any other provider. So this process can never be a side door around
   StarNet's gates: it has no tool implementations at all.

   Input: CLAUDE_CLI_TOOLS_FILE — a JSON array of { name, description, inputSchema } written by the adapter. */
'use strict';
const fs = require('node:fs');

let tools = [];
try { tools = JSON.parse(fs.readFileSync(String(process.env.CLAUDE_CLI_TOOLS_FILE || ''), 'utf8')); } catch (_) { tools = []; }
if (!Array.isArray(tools)) tools = [];

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
function handle(m) {
  if (!m || typeof m !== 'object') return;
  if (m.method === 'initialize') {
    const pv = (m.params && m.params.protocolVersion) || '2025-06-18';
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'starnet', version: '1' } } });
  }
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') return;                       // never executed here — see header
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.id !== undefined && m.id !== null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
