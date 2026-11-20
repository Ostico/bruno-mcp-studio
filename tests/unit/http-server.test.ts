/**
 * The HTTP transport, in-process: the pure checks (token, Host, Origin) as
 * functions, and the request pipeline against a real listener on loopback.
 * tests/integration/mcp-http.test.ts drives the built server with the SDK
 * client; this file is what measures src/.
 */

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  bearerTokenMatches,
  digestTokens,
  formatUrl,
  isAllowedHost,
  isAllowedOrigin,
  MAX_BODY_BYTES,
  MAX_SESSIONS,
  startHttpServer,
  type HttpServerHandle,
  type HttpServerOptions,
} from '../../src/http-server';
import { createBrunoMcpServer, type BrunoMcpServer } from '../../src/server';
import type { HttpTransportConfig } from '../../src/transport-config';
import {
  INITIALIZE,
  MCP_HEADERS,
  openStream,
  sendRequest,
  TOOLS_LIST,
  type Reply,
  type RequestOptions,
} from '../helpers/http-request';

const TOKEN = randomBytes(32).toString('hex');
const SECOND = randomBytes(32).toString('hex');
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

describe('bearerTokenMatches', () => {
  const digests = digestTokens([TOKEN, SECOND]);

  it('accepts either configured token', () => {
    expect(bearerTokenMatches(`Bearer ${TOKEN}`, digests)).toBe(true);
    expect(bearerTokenMatches(`Bearer ${SECOND}`, digests)).toBe(true);
  });

  it('reads the scheme case-insensitively and tolerates surrounding spaces', () => {
    expect(bearerTokenMatches(`bearer  ${TOKEN} `, digests)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['an empty token', 'Bearer '],
    ['a different token of the same length', `Bearer ${randomBytes(32).toString('hex')}`],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, 10)}`],
    ['the token plus a suffix', `Bearer ${TOKEN}x`],
    ['another scheme', `Basic ${TOKEN}`],
    ['no scheme', TOKEN],
    ['two tokens', `Bearer ${TOKEN} ${SECOND}`],
  ])('refuses %s', (_label, header) => {
    expect(bearerTokenMatches(header, digests)).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it.each([
    ['localhost:8781', true],
    ['LOCALHOST:8781', true],
    ['localhost.:8781', true],
    ['[::1]:8781', true],
    ['127.0.0.1', true],
    ['evil.example', false],
    ['evil.example:8781', false],
    ['evil@localhost', false],
    ['', false],
  ])('%j is %s', (host, expected) => {
    expect(isAllowedHost(host, LOOPBACK)).toBe(expected);
  });

  it('refuses a missing Host', () => {
    expect(isAllowedHost(undefined, LOOPBACK)).toBe(false);
  });

  it('accepts anything, even a missing Host, under *', () => {
    expect(isAllowedHost(undefined, ['*'])).toBe(true);
    expect(isAllowedHost('evil.example', ['*'])).toBe(true);
  });
});

describe('isAllowedOrigin', () => {
  it.each([
    [undefined, true],
    ['http://localhost:3000', true],
    ['https://[::1]', true],
    ['http://evil.example', false],
    ['null', false],
    ['file:///etc/passwd', false],
  ])('%j is %s', (origin, expected) => {
    expect(isAllowedOrigin(origin, LOOPBACK)).toBe(expected);
  });

  it('accepts any Origin under *', () => {
    expect(isAllowedOrigin('null', ['*'])).toBe(true);
  });
});

describe('formatUrl', () => {
  it('brackets an IPv6 address', () => {
    expect(formatUrl({ address: '::1', family: 'IPv6', port: 9 }, '/mcp')).toBe('http://[::1]:9/mcp');
    expect(formatUrl({ address: '127.0.0.1', family: 'IPv4', port: 9 }, '/mcp')).toBe('http://127.0.0.1:9/mcp');
  });
});

// ---------------------------------------------------------------------------
// The pipeline, against a real listener
// ---------------------------------------------------------------------------

interface Running {
  handle: HttpServerHandle;
  port: number;
  logs: string[];
}

const running: HttpServerHandle[] = [];

function config(overrides: Partial<HttpTransportConfig> = {}): HttpTransportConfig {
  return {
    kind: 'http',
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    tokens: [TOKEN],
    allowedHosts: LOOPBACK,
    idleTimeoutMs: 60_000,
    ...overrides,
  };
}

async function start(
  overrides: Partial<HttpTransportConfig> = {},
  factory: () => BrunoMcpServer = createBrunoMcpServer,
  options: HttpServerOptions = {},
): Promise<Running> {
  const logs: string[] = [];
  const handle = await startHttpServer(config(overrides), factory, { log: (m) => logs.push(m), ...options });
  running.push(handle);
  return { handle, port: Number(new URL(handle.url).port), logs };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((handle) => handle.close()));
});

const AUTH = { Authorization: `Bearer ${TOKEN}` };
/** Everything an authorised MCP POST carries. */
const MCP = { ...AUTH, ...MCP_HEADERS };

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return sendRequest({ port, method, path, headers, body });
}

/** POST to /mcp as an authorised client, inside a session when one is given. */
function post(port: number, body: string, sessionId?: string): Promise<Reply> {
  const headers = sessionId === undefined ? MCP : { ...MCP, 'mcp-session-id': sessionId };
  return send(port, 'POST', '/mcp', headers, body);
}

/** Initialize a session and return its id. */
async function initialize(port: number): Promise<string> {
  const reply = await post(port, INITIALIZE);
  expect(reply.status).toBe(200);
  const id = reply.headers['mcp-session-id'];
  expect(typeof id).toBe('string');
  return id as string;
}

/** Open the session's SSE stream and leave it open. */
function openSse(port: number, sessionId: string) {
  return openStream({
    port,
    method: 'GET',
    path: '/mcp',
    headers: { ...AUTH, Accept: 'text/event-stream', 'mcp-session-id': sessionId },
  });
}

/** The JSON-RPC payload inside an SSE reply. */
function sseData(body: string): { result?: { tools?: Array<{ name: string }> } } {
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line!.slice('data: '.length));
}

/** Poll until a condition holds; fails the test after about a second. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await sleep(10);
  expect(condition()).toBe(true);
}

/**
 * A factory that records a spy on every server's stop(). `wrap` can change a
 * server before it is handed out.
 */
function spiedFactory(wrap: (server: BrunoMcpServer) => void = () => undefined) {
  const stops: jest.SpyInstance[] = [];
  const factory = (): BrunoMcpServer => {
    const server = createBrunoMcpServer();
    wrap(server);
    stops.push(jest.spyOn(server, 'stop'));
    return server;
  };
  return { factory, stops };
}

describe('startHttpServer', () => {
  it('logs the URL and token count, never the token', async () => {
    const { handle, logs } = await start({ tokens: [TOKEN, SECOND] });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(logs).toEqual([`Bruno MCP Server listening on ${handle.url} (auth: bearer, 2 tokens)`]);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('logs to stderr and reads the real clock by default', async () => {
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const handle = await startHttpServer(config(), createBrunoMcpServer);
      running.push(handle);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('listening on'));
      await initialize(Number(new URL(handle.url).port));
    } finally {
      stderr.mockRestore();
    }
  });

  it('warns when the Host check is off', async () => {
    const { logs } = await start({ allowedHosts: ['*'] });
    expect(logs[0]).toContain('1 token)');
    expect(logs[1]).toContain('allowed hosts include *');
  });

  it('rejects when the port is taken', async () => {
    const { port } = await start();
    await expect(startHttpServer(config({ port }), createBrunoMcpServer, { log: () => undefined }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('answers /healthz to GET and HEAD without a token, and refuses other methods', async () => {
    const { port } = await start();
    const get = await send(port, 'GET', '/healthz?probe=1');
    expect(get).toMatchObject({ status: 200, body: 'OK' });
    expect(get.headers['content-type']).toBe('text/plain');
    expect((await send(port, 'HEAD', '/healthz')).status).toBe(200);
    const postReply = await send(port, 'POST', '/healthz');
    expect(postReply.status).toBe(405);
    expect(postReply.headers.allow).toBe('GET, HEAD');
  });

  it('checks Host before anything else, /healthz included', async () => {
    const { port } = await start();
    const reply = await send(port, 'GET', '/healthz', { Host: 'evil.example' });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body).error.message).toBe('Forbidden: Host not allowed');
    expect((await send(port, 'POST', '/mcp', { ...MCP, Host: 'evil.example' }, INITIALIZE)).status).toBe(403);
  });

  it('refuses a foreign Origin', async () => {
    const { port } = await start();
    const reply = await send(port, 'GET', '/healthz', { Origin: 'http://evil.example' });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body).error.message).toBe('Forbidden: Origin not allowed');
  });

  it('answers 404 for any other path, before asking for a token', async () => {
    const { port } = await start();
    expect((await send(port, 'GET', '/')).status).toBe(404);
    expect((await send(port, 'GET', '/mcp/extra')).status).toBe(404);
  });

  it('answers 401 with a Bearer challenge and no echo', async () => {
    const { port } = await start();
    const wrong = randomBytes(32).toString('hex');
    for (const headers of [{}, { Authorization: `Bearer ${wrong}` }]) {
      const reply = await send(port, 'POST', '/mcp', headers, INITIALIZE);
      expect(reply.status).toBe(401);
      expect(reply.headers['www-authenticate']).toBe('Bearer');
      expect(JSON.parse(reply.body).error.message).toBe('Missing or invalid bearer token');
      expect(reply.body).not.toContain(wrong);
    }
  });

  it('refuses methods other than GET, POST and DELETE on /mcp', async () => {
    const { port } = await start();
    const reply = await send(port, 'PUT', '/mcp', AUTH);
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET, POST, DELETE');
  });

  it('answers -32700 to a body that is not JSON', async () => {
    const { port } = await start();
    const reply = await post(port, '{not json');
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).error.code).toBe(-32700);
  });

  /** POST `size` bytes of spaces, either with a Content-Length or chunked. */
  function postBody(port: number, size: number, chunked: boolean): Promise<Reply> {
    const options: RequestOptions = {
      port,
      method: 'POST',
      path: '/mcp',
      headers: chunked
        ? { ...MCP, 'Transfer-Encoding': 'chunked' }
        : { ...MCP, 'Content-Length': String(size) },
      write: (req) => {
        const chunk = Buffer.alloc(256 * 1024, 0x20);
        for (let sent = 0; sent < size; sent += chunk.length) {
          req.write(chunk.subarray(0, Math.min(chunk.length, size - sent)));
        }
        req.end();
      },
    };
    return sendRequest(options);
  }

  it.each([
    ['declared with a Content-Length', false],
    ['streamed in chunks', true],
  ])('answers 413 to a body over the limit %s, and the client reads it', async (_label, chunked) => {
    const { port } = await start();
    for (let i = 0; i < 5; i++) {
      const reply = await postBody(port, MAX_BODY_BYTES * 2, chunked);
      expect(reply.status).toBe(413);
      expect(JSON.parse(reply.body).error.message).toBe(`Request body over ${MAX_BODY_BYTES} bytes`);
    }
  }, 30_000);

  it('accepts a body of exactly the limit', async () => {
    const { port } = await start();
    // Spaces are valid JSON whitespace, so this is an over-padded parse error,
    // not a size refusal: the size check let it through.
    const reply = await postBody(port, MAX_BODY_BYTES, false);
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).error.code).toBe(-32700);
  }, 30_000);

  it('answers 500 and logs only the message when a body read fails', async () => {
    const { port, logs } = await start();
    const aborted = sendRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP, 'Content-Length': '1000' },
      // Cut the body short: the server's read fails with "aborted".
      write: (req) => {
        req.write('{"partial":');
        setTimeout(() => req.destroy(), 50);
      },
    });
    await expect(aborted).rejects.toThrow();
    await waitUntil(() => logs.length >= 2);
    expect(logs[1]).toMatch(/^\[bruno-mcp http\] request failed: /);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('answers 400 to a non-initialize request, or a GET, without a session', async () => {
    const { port } = await start();
    expect((await post(port, TOOLS_LIST)).status).toBe(400);
    expect((await send(port, 'GET', '/mcp', { ...MCP, 'mcp-session-id': '' })).status).toBe(400);
    // initialize is never batched; a batch is not an initialize.
    expect((await post(port, `[${INITIALIZE}]`)).status).toBe(400);
  });

  it('answers 404 to an unknown session', async () => {
    const { port } = await start();
    const reply = await send(port, 'GET', '/mcp', { ...MCP, 'mcp-session-id': 'nope' });
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body).error.code).toBe(-32001);
  });

  it('serves a session from initialize through DELETE', async () => {
    const { port } = await start();
    const id = await initialize(port);

    const notified = await post(port, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), id);
    expect(notified.status).toBe(202);

    const listed = await post(port, TOOLS_LIST, id);
    expect(listed.status).toBe(200);
    expect(sseData(listed.body).result!.tools!.map((t) => t.name)).toContain('run_collection');

    expect((await send(port, 'DELETE', '/mcp', { ...MCP, 'mcp-session-id': id })).status).toBe(200);
    expect((await post(port, TOOLS_LIST, id)).status).toBe(404);

    // The 404 alone does not prove the table forgot the session: a closed
    // transport answers 404 by itself. A full set of new sessions fitting
    // does, because a leaked entry would still hold a slot.
    for (let i = 0; i < MAX_SESSIONS; i++) await initialize(port);
  }, 30_000);

  it('gives each initialize its own session', async () => {
    const { port } = await start();
    expect(await initialize(port)).not.toBe(await initialize(port));
  });

  it('closes the server of an initialize the transport rejects', async () => {
    const { factory, stops } = spiedFactory();
    const { port } = await start({}, factory);
    // No Accept header: the transport answers 406 and never assigns a session.
    const { Accept: _accept, ...noAccept } = MCP;
    expect((await send(port, 'POST', '/mcp', noAccept, INITIALIZE)).status).toBe(406);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    // The slot was released: a full set of sessions still fits.
    for (let i = 0; i < MAX_SESSIONS; i++) await initialize(port);
  }, 30_000);

  it('refuses an initialize over the session cap with 503', async () => {
    const { port } = await start();
    for (let i = 0; i < MAX_SESSIONS; i++) await initialize(port);
    const reply = await post(port, INITIALIZE);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body).error.message).toBe(`Too many open sessions (limit ${MAX_SESSIONS})`);
  }, 30_000);

  it('answers 500 when building a server fails, and frees the slot', async () => {
    let calls = 0;
    const factory = (): BrunoMcpServer => {
      calls++;
      if (calls === 1) throw new Error('factory broke');
      if (calls === 2) throw 'not an error';
      return createBrunoMcpServer();
    };
    const { port, logs } = await start({}, factory);
    expect((await post(port, INITIALIZE)).status).toBe(500);
    expect((await post(port, INITIALIZE)).status).toBe(500);
    expect(logs.slice(1)).toEqual([
      '[bruno-mcp http] request failed: factory broke',
      '[bruno-mcp http] request failed: unknown error',
    ]);
    await initialize(port);
  });

  it('ignores a failure to stop a server whose connect failed', async () => {
    const broken = {
      connect: () => Promise.reject(new Error('connect broke')),
      stop: () => Promise.reject(new Error('stop broke')),
    } as unknown as BrunoMcpServer;
    const { port, logs } = await start({}, () => broken);
    expect((await post(port, INITIALIZE)).status).toBe(500);
    expect(logs[1]).toBe('[bruno-mcp http] request failed: connect broke');
  });

  it('ends the response when a request fails after its headers were sent', async () => {
    const late = {
      connect: (transport: { handleRequest: unknown }) => {
        transport.handleRequest = async (_req: unknown, res: ServerResponse) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('partial');
          throw new Error('late failure');
        };
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
    } as unknown as BrunoMcpServer;
    const { port, logs } = await start({}, () => late);
    expect(await post(port, INITIALIZE)).toMatchObject({ status: 200, body: 'partial' });
    expect(logs[1]).toBe('[bruno-mcp http] request failed: late failure');
  });

  it('closes sessions idle past the timeout, and keeps busy ones', async () => {
    let clock = 0;
    const { port } = await start({ idleTimeoutMs: 1000 }, createBrunoMcpServer, {
      now: () => clock,
      sweepIntervalMs: 20,
    });
    const idle = await initialize(port);
    const busy = await initialize(port);

    clock = 900;
    expect((await post(port, TOOLS_LIST, busy)).status).toBe(200);
    clock = 1500;
    await sleep(100);

    expect((await post(port, TOOLS_LIST, idle)).status).toBe(404);
    expect((await post(port, TOOLS_LIST, busy)).status).toBe(200);
  });

  it('never sweeps a session while it has a request open', async () => {
    let clock = 0;
    const { port } = await start({ idleTimeoutMs: 1000 }, createBrunoMcpServer, {
      now: () => clock,
      sweepIntervalMs: 20,
    });
    const id = await initialize(port);
    const stream = await openSse(port, id);
    expect(stream.statusCode).toBe(200);

    clock = 5000;
    await sleep(100);
    expect((await post(port, TOOLS_LIST, id)).status).toBe(200);

    // Once the stream ends the session can go idle again.
    stream.destroy();
    await sleep(100);
    clock = 5500;
    await sleep(100);
    expect((await post(port, TOOLS_LIST, id)).status).toBe(200);
    clock = 7000;
    await sleep(100);
    expect((await post(port, TOOLS_LIST, id)).status).toBe(404);
  });

  it('closes open sessions and the listener on close, once', async () => {
    const { factory, stops } = spiedFactory();
    const { handle, port } = await start({}, factory);
    await initialize(port);
    await initialize(port);
    const first = handle.close();
    expect(handle.close()).toBe(first);
    await first;
    expect(stops).toHaveLength(2);
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    await expect(send(port, 'GET', '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('closes an initialize still connecting when close() begins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transportClose: jest.SpyInstance | undefined;
    const { factory } = spiedFactory((server) => {
      const connect = server.connect.bind(server);
      server.connect = async (transport) => {
        transportClose = jest.spyOn(transport, 'close');
        await gate;
        return connect(transport);
      };
    });
    const { handle, port } = await start({}, factory);
    const pending = post(port, INITIALIZE).catch(() => undefined);
    await waitUntil(() => transportClose !== undefined);

    const closed = handle.close();
    release();
    await closed;
    await pending;
    // Stopping the server is not enough here: its connect has not finished,
    // so it does not own the transport yet, and the initialize would go on
    // to register a session behind close().
    expect(transportClose).toHaveBeenCalled();
  });

  it('closes even with an SSE stream held open', async () => {
    const { handle, port } = await start();
    const stream = await openSse(port, await initialize(port));
    expect(stream.statusCode).toBe(200);
    stream.resume();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
