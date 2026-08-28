import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the MCP SDK client + transports ───────────────────────────────
// NOTE: client.js constructs these with `new` (new Client(...), new
// StreamableHTTPClientTransport(...)). Under vitest 4 a vi.fn() whose
// implementation is an ARROW function is not constructable — Reflect.construct
// throws "is not a constructor". So the mock implementations below use regular
// `function` expressions (vitest 4's own error message recommends a function or
// class). This is the only change vs. the plan's verbatim mock; every captured
// var, return value, and assertion is unchanged.
const connectMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: connectMock,
      listTools: listToolsMock,
      callTool: callToolMock,
      close: closeMock,
      getServerVersion: () => ({ name: 'mock-server', version: '9.9.9' }),
    };
  }),
}));

let lastHttpOpts;
let lastSseOpts;
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function (url, opts) {
    lastHttpOpts = opts;
    return { kind: 'http', url };
  }),
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(function (url, opts) {
    lastSseOpts = opts;
    return { kind: 'sse', url };
  }),
}));

import { listTools, callTool, testConnection } from '../client.js';

const baseConfig = {
  url: 'https://api.example.com/mcp',
  transport: 'http',
  authType: 'bearer',
  secret: 'tok',
};
// Inject a lookup that resolves to a public IP so the SSRF guard passes.
const lookup = () => Promise.resolve(['93.184.216.34']);

beforeEach(() => {
  vi.clearAllMocks();
  lastHttpOpts = undefined;
  lastSseOpts = undefined;
});

describe('listTools', () => {
  it('connects, returns tool list, and closes', async () => {
    connectMock.mockResolvedValue(undefined);
    listToolsMock.mockResolvedValue({
      tools: [{ name: 'create_issue', description: 'Make an issue', inputSchema: { type: 'object' } }],
    });
    const res = await listTools(baseConfig, { lookup });
    expect(res.ok).toBe(true);
    expect(res.tools[0].name).toBe('create_issue');
    expect(connectMock).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
    // R1-5: the guarded fetch (re-validates every hop) is wired into the transport
    // via the SDK `fetch` option, alongside the auth headers in `requestInit`.
    expect(typeof lastHttpOpts.fetch).toBe('function');
    expect(lastHttpOpts.requestInit.headers).toEqual({ Authorization: 'Bearer tok' });
  });
  it('routes to the SSE transport with a guarded fetch when transport=sse', async () => {
    connectMock.mockResolvedValue(undefined);
    listToolsMock.mockResolvedValue({ tools: [] });
    const res = await listTools({ ...baseConfig, transport: 'sse' }, { lookup });
    expect(res.ok).toBe(true);
    expect(lastSseOpts).toBeDefined();
    expect(typeof lastSseOpts.fetch).toBe('function');
    expect(lastHttpOpts).toBeUndefined();
  });
  it('blocks SSRF before connecting', async () => {
    const res = await listTools(
      { ...baseConfig, url: 'http://169.254.169.254/mcp' },
      { lookup: () => Promise.resolve(['169.254.169.254']) },
    );
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('ssrf_blocked');
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('callTool', () => {
  it('calls a tool and returns its result', async () => {
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const res = await callTool(baseConfig, 'create_issue', { title: 't' }, { lookup });
    expect(res.ok).toBe(true);
    expect(res.data.content[0].text).toBe('ok');
    expect(callToolMock).toHaveBeenCalledWith({ name: 'create_issue', arguments: { title: 't' } });
  });
  it('returns a normalized error when the tool throws', async () => {
    callToolMock.mockRejectedValue(new Error('boom'));
    const res = await callTool(baseConfig, 'create_issue', {}, { lookup });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('tool_error');
  });
});

describe('testConnection', () => {
  it('returns server info and tool count', async () => {
    listToolsMock.mockResolvedValue({ tools: [{ name: 'a' }, { name: 'b' }] });
    const res = await testConnection(baseConfig, { lookup });
    expect(res.ok).toBe(true);
    expect(res.serverInfo.name).toBe('mock-server');
    expect(res.toolCount).toBe(2);
  });
});
