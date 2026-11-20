/**
 * End-to-end proof of the HTTP transport: the built server is spawned with
 * `--transport http --port 0` and driven by the official SDK client over
 * Streamable HTTP, plus raw requests for the checks that sit in front of MCP
 * (Host, Origin, bearer token, health check).
 *
 * The stdio suite (mcp-stdio.test.ts) is the proof that stdio did not change;
 * this one is the proof that HTTP serves the same tools, keeps sessions apart,
 * and never lets the token out.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { EXPECTED_TOOLS } from '../helpers/expected-tools';

const repoRoot = path.resolve(__dirname, '../..');
// Built once by tests/global-setup.ts before any worker starts.
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

const TOKEN = randomBytes(32).toString('hex');

interface Server {
  child: ChildProcess;
  url: URL;
  stderr: () => string;
}

const children: ChildProcess[] = [];
const clients: Client[] = [];
let tmpRoot: string;
let server: Server;

/** The parent's environment minus any BRUNO_* a developer exported (see mcp-stdio). */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('BRUNO_') && key !== 'BRUNO_WORKSPACE_PATH') continue;
    base[key] = value;
  }
  return { ...base, ...overrides };
}

function spawnServer(args: string[], env: Record<string, string>): { child: ChildProcess; stderr: () => string } {
  const child = spawn(process.execPath, [serverEntry, ...args], {
    cwd: repoRoot,
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let text = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { child, stderr: () => text };
}

async function startServer(): Promise<Server> {
  const { child, stderr } = spawnServer(['--transport', 'http', '--port', '0'], {
    BRUNO_MCP_AUTH_TOKEN: TOKEN,
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const match = /listening on (http:\/\/\S+)/.exec(stderr());
    if (match) return { child, url: new URL(match[1]!), stderr };
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`server did not start (exit ${child.exitCode}). stderr:\n${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * A raw request over node:http, so a probe can set a Host header (fetch will
 * not) and nothing here depends on the process-global fetch dispatcher.
 */
function raw(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: server.url.hostname, port: server.url.port, path: pathname, method, headers },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

async function connect(token = TOKEN): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(server.url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-http-harness', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'bruno-mcp-http-'));
  server = await startServer();
}, 30_000);

afterAll(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
}, 30_000);

describe('MCP HTTP transport (real child process)', () => {
  it('answers /healthz without a token', async () => {
    const res = await raw('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toBe('OK');
  });

  it('refuses /mcp without a token, with a Bearer challenge', async () => {
    const res = await raw('POST', '/mcp', MCP_HEADERS, INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('refuses a wrong token without echoing it', async () => {
    const wrong = randomBytes(32).toString('hex');
    const res = await raw('POST', '/mcp', { ...MCP_HEADERS, Authorization: `Bearer ${wrong}` }, INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Missing or invalid bearer token');
    expect(res.body).not.toContain(wrong);
    expect(JSON.stringify(res.headers)).not.toContain(wrong);
  });

  it('lists exactly the expected tools to an authorised client', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'bruno-mcp' });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  }, 30_000);

  it('refuses a foreign Host on /mcp and on /healthz', async () => {
    const onHealth = await raw('GET', '/healthz', { Host: 'evil.example' });
    expect(onHealth.status).toBe(403);
    expect(onHealth.body).not.toContain('OK');
    const onMcp = await raw('POST', '/mcp', {
      ...MCP_HEADERS,
      Host: `evil.example:${server.url.port}`,
      Authorization: `Bearer ${TOKEN}`,
    }, INITIALIZE);
    expect(onMcp.status).toBe(403);
  });

  it('refuses a foreign Origin', async () => {
    const res = await raw('POST', '/mcp', {
      ...MCP_HEADERS,
      Origin: 'http://evil.example',
      Authorization: `Bearer ${TOKEN}`,
    }, INITIALIZE);
    expect(res.status).toBe(403);
  });

  it('keeps two sessions apart, and closing one leaves the other working', async () => {
    const first = await connect();
    const second = await connect();
    expect(first.transport.sessionId).toBeDefined();
    expect(second.transport.sessionId).toBeDefined();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);

    for (const { client } of [first, second]) {
      const listed = await client.callTool({ name: 'list_collections', arguments: {} });
      expect(listed.isError).toBeFalsy();
    }

    await first.transport.terminateSession();
    await first.client.close();

    const still = await second.client.callTool({ name: 'list_collections', arguments: {} });
    expect(still.isError).toBeFalsy();
  }, 30_000);

  it('answers 404 for a session the client deleted', async () => {
    const { client, transport } = await connect();
    const id = transport.sessionId!;
    await transport.terminateSession();
    await client.close();

    const res = await raw('POST', '/mcp', {
      ...MCP_HEADERS,
      Authorization: `Bearer ${TOKEN}`,
      'mcp-session-id': id,
    }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    expect(res.status).toBe(404);
  }, 30_000);

  it('serialises writes from two sessions to one environment file', async () => {
    const outputPath = path.join(tmpRoot, 'concurrency');
    const collectionPath = path.join(outputPath, 'shared');
    const a = await connect();
    const b = await connect();

    const created = await a.client.callTool({
      name: 'create_collection',
      arguments: { name: 'shared', outputPath, format: 'yaml' },
    });
    expect(created.isError).toBeFalsy();
    const env = await a.client.callTool({
      name: 'create_environment',
      arguments: { collectionPath, name: 'dev', variables: {} },
    });
    expect(env.isError).toBeFalsy();

    const calls = [];
    for (let i = 0; i < 20; i++) {
      for (const [label, { client }] of [['a', a], ['b', b]] as const) {
        calls.push(client.callTool({
          name: 'set_environment_variable',
          arguments: { collectionPath, environment: 'dev', name: `${label}${i}`, value: `${label}-${i}` },
        }));
      }
    }
    const results = await Promise.all(calls);
    for (const result of results) expect(result.isError).toBeFalsy();

    const read = await b.client.callTool({
      name: 'read_environment',
      arguments: { collectionPath, name: 'dev' },
    });
    expect(read.isError).toBeFalsy();
    const text = textOf(read);
    for (let i = 0; i < 20; i++) {
      expect(text).toContain(`a${i}`);
      expect(text).toContain(`b${i}`);
    }
    // The tool's answer and the file have to agree.
    const file = readFileSync(path.join(collectionPath, 'environments', 'dev.yml'), 'utf8');
    for (let i = 0; i < 20; i++) {
      expect(file).toContain(`a-${i}`);
      expect(file).toContain(`b-${i}`);
    }
  }, 60_000);

  it('never writes the token to stderr', () => {
    expect(server.stderr()).toContain('listening on');
    expect(server.stderr()).not.toContain(TOKEN);
  });
});

describe('MCP HTTP transport configuration errors', () => {
  it('exits 2 and names BRUNO_MCP_AUTH_TOKEN when started without a token', async () => {
    const { child, stderr } = spawnServer(['--transport', 'http', '--port', '0'], {});
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(2);
    expect(stderr()).toContain('BRUNO_MCP_AUTH_TOKEN');
    // One line, no stack trace.
    expect(stderr().trim().split('\n')).toHaveLength(1);
  }, 30_000);
});
