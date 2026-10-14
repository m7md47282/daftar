#!/usr/bin/env node
// daftar MCP server — lets Claude act as the owner's accountant through the system's own API.
// It holds no logic: every tool is listed and executed by the daftar API with the owner's
// personal key, so Claude can only do what the system allows, and every write needs a
// preview + the user's approval (confirm_token) before it is saved.
//
// Env: DAFTAR_URL (e.g. https://app.example.com), DAFTAR_TOKEN (created in إعدادات النظام ← المحاسب الذكي)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const base = (process.env.DAFTAR_URL ?? 'http://localhost:8094').replace(/\/$/, '');
const token = process.env.DAFTAR_TOKEN;
if (!token) { console.error('DAFTAR_TOKEN is required'); process.exit(1); }

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const server = new Server(
  { name: 'daftar', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions:
    'You are the accountant for a Saudi trading business, working only through these tools. Answer in Arabic. ' +
    'Search before using ids. Prices are SAR excluding 15% VAT unless the user says otherwise. ' +
    'Write tools return a preview and a confirm_token first: show the preview to the user, wait for an explicit yes, then call again with the same input plus confirm_token.' });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await api('GET', '/mcp/tools') }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const out = await api('POST', `/mcp/tools/${encodeURIComponent(req.params.name)}`, req.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
