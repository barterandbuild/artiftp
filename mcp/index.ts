/**
 * ArtiFTP MCP stub — tools call the local ArtiFTP API with a session token.
 * Env: ARTIFTP_API_URL (default http://127.0.0.1:8787), ARTIFTP_SESSION_TOKEN (optional); AGENTFTP_* aliases remain supported
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API = process.env.ARTIFTP_API_URL || process.env.AGENTFTP_API_URL || 'http://127.0.0.1:8787';
let sessionToken = process.env.ARTIFTP_SESSION_TOKEN || process.env.AGENTFTP_SESSION_TOKEN || '';
let lastRequestId = '';

async function api(path: string, opts: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

const server = new Server(
  { name: 'artiftp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sites',
      description: 'List ArtiFTP sites available to request access',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'request_access',
      description: 'Request owner-approved access to a site (returns pending until Approve)',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string' },
          slug: { type: 'string' },
          purpose: { type: 'string' },
          mode: { type: 'string', enum: ['read', 'read_write'] },
          ttl_sec: { type: 'number' },
          path_hint: { type: 'string' },
        },
      },
    },
    {
      name: 'session_status',
      description: 'Check session / request status; returns session_token once after approve',
      inputSchema: {
        type: 'object',
        properties: { request_id: { type: 'string' } },
      },
    },
    {
      name: 'list_files',
      description: 'List files under jailed root',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
    {
      name: 'upload_file',
      description: 'Upload a text or base64 file inside the jail',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          content_base64: { type: 'string' },
        },
        required: ['path'],
      },
    },
    {
      name: 'download_file',
      description: 'Download a file from the jail',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'end_session',
      description: 'Revoke the current session early',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (name) {
      case 'list_sites':
        result = await api('/tools/list_sites');
        break;
      case 'request_access':
        result = await api('/tools/request_access', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        lastRequestId = String((result as { request_id?: string }).request_id || '');
        break;
      case 'session_status': {
        const rid = String(args.request_id || lastRequestId || '');
        const q = rid ? `?request_id=${encodeURIComponent(rid)}` : '';
        result = await api(`/tools/session_status${q}`);
        const tok = (result as { session_token?: string }).session_token;
        if (tok) sessionToken = tok;
        break;
      }
      case 'list_files': {
        const p = args.path != null ? `?path=${encodeURIComponent(String(args.path))}` : '';
        result = await api(`/tools/list_files${p}`);
        break;
      }
      case 'upload_file':
        result = await api('/tools/upload_file', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        break;
      case 'download_file':
        result = await api(
          `/tools/download_file?path=${encodeURIComponent(String(args.path || ''))}`,
        );
        break;
      case 'end_session':
        result = await api('/tools/end_session', { method: 'POST', body: '{}' });
        sessionToken = '';
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e: unknown) {
    return {
      isError: true,
      content: [{ type: 'text', text: String(e instanceof Error ? e.message : e) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[artiftp-mcp] connected (API ' + API + ')');
