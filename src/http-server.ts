/**
 * Streamable HTTP transport, protected by a static bearer token.
 *
 * One process serves many clients, each in its own MCP session: every
 * `initialize` builds a fresh BrunoMcpServer and transport, so sessions never
 * share a JSON-RPC stream. What they do share is the process, and with it the
 * per-file write lock in path-mutex.ts, which is what keeps two clients writing
 * the same environment file from losing each other's keys.
 *
 * Plain node:http on purpose: the SDK transport takes IncomingMessage and
 * ServerResponse directly, so a framework would add a dependency and nothing
 * else.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { BrunoMcpServer } from './server.js';
import { normalizeHostname, type HttpTransportConfig } from './transport-config.js';

/** Largest request body accepted. A write_request batch is well under this. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Open sessions allowed at once; bounds memory if a client leaks sessions. */
export const MAX_SESSIONS = 64;
/** How often idle sessions are looked for. */
export const IDLE_SWEEP_MS = 60_000;

export interface HttpServerHandle {
  /** The MCP endpoint, with the port actually bound (useful when 0 was asked). */
  url: string;
  /** Close every session, then the listener. Safe to call more than once. */
  close(): Promise<void>;
}

/** Hooks for tests; production uses the defaults. */
export interface HttpServerOptions {
  now?: () => number;
  log?: (message: string) => void;
  sweepIntervalMs?: number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Hash every configured token once, so a request only hashes its own. */
export function digestTokens(tokens: readonly string[]): Buffer[] {
  return tokens.map(digest);
}

/**
 * Whether an Authorization header carries one of the configured tokens.
 *
 * Both sides are SHA-256 digests, so timingSafeEqual always compares 32 bytes
 * and a length difference leaks nothing. Every token is compared, with no early
 * return, so the time taken does not say which one matched.
 */
export function bearerTokenMatches(header: string | undefined, tokenDigests: readonly Buffer[]): boolean {
  if (header === undefined) return false;
  const match = /^Bearer +([\x21-\x7e]+) *$/i.exec(header);
  if (match === null) return false;
  const presented = digest(match[1]!);
  let found = false;
  for (const expected of tokenDigests) {
    if (timingSafeEqual(presented, expected)) found = true;
  }
  return found;
}

/**
 * Whether a Host header names an allowed host. The port is ignored: a container
 * reaches the server as `host.docker.internal:8781`, and listing every port
 * alongside every name would only invite a mismatch.
 */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.includes('*')) return true;
  if (hostHeader === undefined) return false;
  const hostname = normalizeHostname(hostHeader);
  return hostname !== undefined && allowedHosts.includes(hostname);
}

/**
 * Whether an Origin header is acceptable. Absent is fine (a CLI client sends
 * none, a browser always does); present, its hostname must be allowed. `null`
 * and anything unparseable are refused.
 */
export function isAllowedOrigin(origin: string | undefined, allowedHosts: readonly string[]): boolean {
  if (origin === undefined) return true;
  if (allowedHosts.includes('*')) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return isAllowedHost(host, allowedHosts);
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Read the body as text, or undefined when it is over MAX_BODY_BYTES. Nothing
 * past the limit is buffered.
 *
 * An oversized body is read to its end and discarded before the refusal is
 * sent. Answering early and closing looks cheaper and does not work: the client
 * is still writing, the close turns into a reset, and the reset makes the
 * client's kernel drop the 413 before it is read (measured: 2 in 40 arrived).
 * Draining costs bandwidth, not memory, and only a client that already passed
 * the token check gets this far. Node's requestTimeout bounds a body that
 * never ends.
 */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * One client's MCP session: its own server and transport, and whether it is in
 * use.
 */
class Session {
  readonly transport: StreamableHTTPServerTransport;
  private lastSeen: number;
  /**
   * Requests still being answered, an open SSE stream included. A session with
   * one is in use however long ago it started, so it is never idle: a
   * run_collection that outlasts the timeout must not lose its own response.
   */
  private inFlight = 0;

  constructor(
    readonly server: BrunoMcpServer,
    private readonly now: () => number,
    onInitialized: (id: string) => void,
  ) {
    this.lastSeen = now();
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: onInitialized,
    });
  }

  /** Assigned by the transport when the initialize is accepted. */
  get id(): string | undefined {
    return this.transport.sessionId;
  }

  /** Count a request as open until its response closes. */
  track(res: ServerResponse): void {
    this.inFlight++;
    this.lastSeen = this.now();
    res.once('close', () => {
      this.inFlight--;
      this.lastSeen = this.now();
    });
  }

  isIdleSince(cutoff: number): boolean {
    return this.inFlight === 0 && this.lastSeen < cutoff;
  }

  /**
   * Close the transport, which ends any open SSE stream and fires its onclose,
   * then the server. The transport goes first because a server whose connect
   * has not finished yet would not close it. A failure is ignored: there is
   * nothing left to tell.
   */
  async close(): Promise<void> {
    try {
      await this.transport.close();
      await this.server.stop();
    } catch {
      /* already closed */
    }
  }
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function formatUrl(address: AddressInfo, path: string): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}${path}`;
}

/**
 * Start the HTTP transport. Resolves once the listener is bound; rejects if it
 * cannot bind (a port in use, an address not on this machine).
 */
export async function startHttpServer(
  config: HttpTransportConfig,
  createServerInstance: () => BrunoMcpServer,
  options: HttpServerOptions = {},
): Promise<HttpServerHandle> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  const tokenDigests = digestTokens(config.tokens);
  // Every session from the moment its server is built until it closes, so the
  // cap and close() also see an initialize still in flight.
  const live = new Set<Session>();
  // Initialized sessions by id, for routing requests.
  const byId = new Map<string, Session>();

  const handleInitialize = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    if (live.size >= MAX_SESSIONS) {
      sendJsonRpcError(res, 503, -32000, `Too many open sessions (limit ${MAX_SESSIONS})`);
      return;
    }
    const session = new Session(createServerInstance(), now, (id) => byId.set(id, session));
    // Set before connect: Protocol.connect chains whatever onclose is already
    // there, so this runs however the session ends.
    session.transport.onclose = () => {
      live.delete(session);
      if (session.id !== undefined) byId.delete(session.id);
    };
    live.add(session);
    session.track(res);
    try {
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, body);
    } finally {
      // A rejected initialize (a missing Accept header, say) never gets an id,
      // so nothing else would ever close it.
      if (session.id === undefined) await session.close();
    }
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Always set on a server-side request; typed optional for client ones.
    const method = String(req.method);
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      sendJsonRpcError(res, 405, -32000, 'Method not allowed', { Allow: 'GET, POST, DELETE' });
      return;
    }

    let body: unknown;
    if (method === 'POST') {
      const text = await readBody(req);
      if (text === undefined) {
        sendJsonRpcError(res, 413, -32000, `Request body over ${MAX_BODY_BYTES} bytes`);
        return;
      }
      try {
        body = JSON.parse(text);
      } catch {
        sendJsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON');
        return;
      }
    }

    const sessionId = sessionIdOf(req);
    if (sessionId === undefined) {
      if (method === 'POST' && isInitializeRequest(body)) {
        await handleInitialize(req, res, body);
        return;
      }
      sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      return;
    }

    const session = byId.get(sessionId);
    if (session === undefined) {
      // 404 tells a spec-following client to start a new session.
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    session.track(res);
    await session.transport.handleRequest(req, res, body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Host first, on every path: a DNS-rebinding page must not even learn that
    // something answers /healthz here.
    if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
      sendJsonRpcError(res, 403, -32000, 'Forbidden: Host not allowed');
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, config.allowedHosts)) {
      sendJsonRpcError(res, 403, -32000, 'Forbidden: Origin not allowed');
      return;
    }

    const pathname = new URL(String(req.url), 'http://localhost').pathname;
    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(req.method === 'HEAD' ? undefined : 'OK');
      return;
    }
    if (pathname !== config.path) {
      sendJsonRpcError(res, 404, -32000, 'Not found');
      return;
    }

    // Never echoes the header back, so a mistyped token is not reflected.
    if (!bearerTokenMatches(req.headers.authorization, tokenDigests)) {
      sendJsonRpcError(res, 401, -32000, 'Missing or invalid bearer token', {
        'WWW-Authenticate': 'Bearer',
      });
      return;
    }

    await handleMcp(req, res);
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // The message only: a stack or a request dump could carry headers.
      const message = error instanceof Error ? error.message : 'unknown error';
      log(`[bruno-mcp http] request failed: ${message}`);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal error');
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const url = formatUrl(httpServer.address() as AddressInfo, config.path);

  const sweep = setInterval(() => {
    const cutoff = now() - config.idleTimeoutMs;
    for (const session of live) {
      if (session.isIdleSince(cutoff)) void session.close();
    }
  }, options.sweepIntervalMs ?? IDLE_SWEEP_MS);
  sweep.unref();

  const count = config.tokens.length;
  log(`Bruno MCP Server listening on ${url} (auth: bearer, ${count} token${count === 1 ? '' : 's'})`);
  if (config.allowedHosts.includes('*')) {
    log('[bruno-mcp http] WARNING: allowed hosts include *, so the Host and Origin checks are off. '
      + 'Any web page the user visits can reach this server if it can reach the port.');
  }

  const shutdown = async (): Promise<void> => {
    clearInterval(sweep);
    // Stop accepting first, so no session can start behind the snapshot below.
    const listenerClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await Promise.all([...live].map((session) => session.close()));
    // An open SSE stream would otherwise keep the listener waiting forever.
    httpServer.closeAllConnections();
    await listenerClosed;
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= shutdown());

  return { url, close };
}
