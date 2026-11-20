/**
 * Transport selection for the bruno-mcp entry point.
 *
 * stdio is the default and takes no configuration. HTTP mode serves several
 * clients from one process (for example one server on a host shared by many
 * containers), so it is opt-in and refuses to start without a bearer token:
 * there is no configuration in which it listens unauthenticated.
 *
 * Everything here is a pure function of argv, the environment and the token
 * file, so every rule can be tested without starting a server.
 */

import { readFileSync } from 'node:fs';

export interface StdioTransportConfig {
  kind: 'stdio';
  /**
   * Arguments nothing here recognises. Up to 2.5.0 the server ignored its
   * arguments altogether, so under stdio they are still ignored, and only
   * reported, rather than turning a working client config into a failed start.
   */
  ignoredArgs: string[];
}

export interface HttpTransportConfig {
  kind: 'http';
  /** Interface to bind. Loopback unless the caller asks otherwise. */
  host: string;
  /** 0 asks the OS for a free port; the chosen one is logged on start. */
  port: number;
  path: '/mcp';
  /** Accepted bearer tokens. More than one allows rotation without downtime. */
  tokens: string[];
  /**
   * Hostnames accepted in the Host and Origin headers, lowercased, IPv6 in
   * brackets. `*` accepts any host.
   */
  allowedHosts: string[];
  idleTimeoutMs: number;
}

export interface HelpConfig {
  kind: 'help';
}

export type TransportConfig = StdioTransportConfig | HttpTransportConfig | HelpConfig;

/**
 * A configuration the server refuses to start with. The message is printed to
 * the user as is, so it must never carry a token value.
 */
export class TransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportConfigError';
  }
}

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8781;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_TOKEN_LENGTH = 32;

/**
 * Always accepted in Host and Origin. A loopback name in the Host header cannot
 * come from a DNS-rebinding page (the browser would send the attacker's name),
 * so keeping these on even when the caller supplies a list costs nothing, and
 * it lets a local health check reach a server bound for containers.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const USAGE = `Usage: bruno-mcp [options]

With no options the server speaks MCP over stdio.

Options:
  --transport stdio|http   Transport (env BRUNO_MCP_TRANSPORT, default stdio)
  --host HOST              HTTP bind address (env BRUNO_MCP_HOST, default ${DEFAULT_HTTP_HOST})
  --port PORT              HTTP port, 0 for any free port (env BRUNO_MCP_PORT, default ${DEFAULT_HTTP_PORT})
  --auth-token-file PATH   File holding the bearer token(s) (env BRUNO_MCP_AUTH_TOKEN_FILE)
  --allowed-hosts A,B      Extra hostnames accepted in Host and Origin; * accepts any
                           (env BRUNO_MCP_ALLOWED_HOSTS; localhost, 127.0.0.1, [::1]
                           and the bind host are always accepted)
  -h, --help               Print this help and exit

Environment only:
  BRUNO_MCP_AUTH_TOKEN       Bearer token(s), comma-separated, at least ${MIN_TOKEN_LENGTH} characters each.
                             There is deliberately no --auth-token flag: a token on the
                             command line is visible in ps and in shell history.
  BRUNO_MCP_SESSION_IDLE_MS  Close an HTTP session idle this long (default ${DEFAULT_IDLE_TIMEOUT_MS})

HTTP mode refuses to start without a token. GET /healthz answers OK without one.`;

/** Flags that only mean something with --transport http; refused under stdio. */
const HTTP_ONLY_FLAGS = new Set(['--host', '--port', '--auth-token-file', '--allowed-hosts']);
/** Every flag that takes a value. */
const VALUE_FLAGS = new Set(['--transport', ...HTTP_ONLY_FLAGS]);

type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, 'utf8');

interface ParsedFlags {
  flags: Map<string, string>;
  help: boolean;
  unknown: string[];
}

/**
 * Parse argv into flag values. Both `--flag value` and `--flag=value` are
 * accepted. Unrecognised arguments are collected rather than thrown, because
 * whether they are fatal depends on the transport (see resolveTransportConfig).
 */
function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags = new Map<string, string>();
  const unknown: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--auth-token' || arg.startsWith('--auth-token=')) {
      throw new TransportConfigError(
        '--auth-token is not accepted: a token on the command line shows in ps and shell history. '
          + 'Set BRUNO_MCP_AUTH_TOKEN or pass --auth-token-file instead.',
      );
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.has(name)) {
      unknown.push(arg);
      continue;
    }

    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      throw new TransportConfigError(`${name} needs a value`);
    }
    if (flags.has(name)) {
      throw new TransportConfigError(`${name} was given more than once`);
    }
    flags.set(name, value);
  }

  return { flags, help, unknown };
}

/** An environment variable, trimmed; empty counts as unset. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === '' ? undefined : value;
}

/** A flag wins over its environment variable. */
function pick(flags: Map<string, string>, flag: string, env: NodeJS.ProcessEnv, name: string): string | undefined {
  return flags.get(flag) ?? envValue(env, name);
}

function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    throw new TransportConfigError(`${source} must be an integer from 0 to 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function parseIdleTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1) {
    throw new TransportConfigError(
      `BRUNO_MCP_SESSION_IDLE_MS must be a positive integer of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Split a token list on commas and newlines. A file may hold one token per line,
 * the environment variable a comma-separated list; either form works in both.
 */
function splitTokens(raw: string): string[] {
  return raw
    .split(/[,\r\n]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Check every token in one list. Messages name where a token came from and its
 * position, never its value: these errors are printed, and a printed token is a
 * leaked one.
 */
function checkTokens(label: string, tokens: string[]): string[] {
  for (const [index, token] of tokens.entries()) {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new TransportConfigError(
        `Token ${index + 1} from ${label} is ${token.length} characters; at least ${MIN_TOKEN_LENGTH} are required`,
      );
    }
    // An Authorization header carries visible ASCII without spaces. A token
    // outside that range could never be presented, so it is a config typo.
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new TransportConfigError(
        `Token ${index + 1} from ${label} contains whitespace or a non-ASCII character`,
      );
    }
  }
  return tokens;
}

function readTokenFile(path: string, readFile: ReadFile): string {
  try {
    return readFile(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new TransportConfigError(
      `Cannot read the token file ${path} (${typeof code === 'string' ? code : 'unreadable'})`,
    );
  }
}

/** Every token from the environment and the token file, duplicates removed. */
function resolveTokens(env: NodeJS.ProcessEnv, tokenFile: string | undefined, readFile: ReadFile): string[] {
  const fromEnv = envValue(env, 'BRUNO_MCP_AUTH_TOKEN');
  const tokens = [
    ...(fromEnv === undefined ? [] : checkTokens('BRUNO_MCP_AUTH_TOKEN', splitTokens(fromEnv))),
    ...(tokenFile === undefined
      ? []
      : checkTokens(`token file ${tokenFile}`, splitTokens(readTokenFile(tokenFile, readFile)))),
  ];
  if (tokens.length === 0) {
    throw new TransportConfigError(
      'HTTP transport needs a bearer token: set BRUNO_MCP_AUTH_TOKEN or BRUNO_MCP_AUTH_TOKEN_FILE '
        + '(or pass --auth-token-file). It never starts without one.',
    );
  }
  return [...new Set(tokens)];
}

/**
 * Normalise a hostname the way a Host header is compared: lowercase, no port,
 * no trailing dot, IPv6 in brackets. Returns undefined for anything that is not
 * a plain hostname, which includes userinfo and paths: `new URL` would happily
 * read `evil@localhost` as `localhost`.
 */
export function normalizeHostname(raw: string): string | undefined {
  let value = raw.trim();
  if (value === '' || !/^[A-Za-z0-9.\-[\]:]+$/.test(value)) return undefined;
  // A bare IPv6 literal (two or more colons, no brackets) is bracketed so it
  // reads as an address and not as host:port.
  if (!value.startsWith('[') && (value.match(/:/g)?.length ?? 0) > 1) {
    value = `[${value}]`;
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${value}`).hostname;
  } catch {
    return undefined;
  }
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  return hostname === '' ? undefined : hostname.toLowerCase();
}

function resolveAllowedHosts(raw: string | undefined, bindHost: string): string[] {
  const hosts = new Set(LOOPBACK_HOSTS);
  const bind = normalizeHostname(bindHost);
  if (bind !== undefined) hosts.add(bind);

  if (raw !== undefined) {
    for (const entry of raw.split(',').map((item) => item.trim()).filter((item) => item !== '')) {
      if (entry === '*') {
        hosts.add('*');
        continue;
      }
      const host = normalizeHostname(entry);
      if (host === undefined) {
        throw new TransportConfigError(`Allowed host ${JSON.stringify(entry)} is not a valid hostname`);
      }
      hosts.add(host);
    }
  }
  return [...hosts];
}

/**
 * Decide the transport from the command line and the environment. Flags win
 * over environment variables. Throws TransportConfigError for any setting the
 * server must not start with.
 */
export function resolveTransportConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  readFile: ReadFile = defaultReadFile,
): TransportConfig {
  const { flags, help, unknown } = parseFlags(argv);
  if (help) return { kind: 'help' };

  const transport = (pick(flags, '--transport', env, 'BRUNO_MCP_TRANSPORT') ?? 'stdio').toLowerCase();
  if (transport !== 'stdio' && transport !== 'http') {
    throw new TransportConfigError(`Unknown transport ${JSON.stringify(transport)}: use stdio or http`);
  }

  if (transport === 'stdio') {
    // BRUNO_MCP_HOST, _PORT and the token variables are ignored here, so a
    // shell profile that sets them for an HTTP server cannot break a stdio
    // client. BRUNO_MCP_TRANSPORT is the exception: it selects the mode, so a
    // profile exporting it switches every server that inherits it. An HTTP
    // flag, though, was typed for this invocation, and dropping it silently
    // would hide a missing --transport.
    for (const flag of HTTP_ONLY_FLAGS) {
      if (flags.has(flag)) {
        throw new TransportConfigError(`${flag} only applies to --transport http`);
      }
    }
    return { kind: 'stdio', ignoredArgs: unknown };
  }

  // HTTP mode is new, so nothing depends on it ignoring arguments, and a
  // misspelt flag here would otherwise change what the server exposes.
  if (unknown.length > 0) {
    throw new TransportConfigError(`Unknown argument: ${unknown[0]}`);
  }

  const host = pick(flags, '--host', env, 'BRUNO_MCP_HOST') ?? DEFAULT_HTTP_HOST;
  const portRaw = pick(flags, '--port', env, 'BRUNO_MCP_PORT');
  const port = portRaw === undefined
    ? DEFAULT_HTTP_PORT
    : parsePort(portRaw, flags.has('--port') ? '--port' : 'BRUNO_MCP_PORT');
  const tokenFile = pick(flags, '--auth-token-file', env, 'BRUNO_MCP_AUTH_TOKEN_FILE');
  const tokens = resolveTokens(env, tokenFile, readFile);
  const allowedHosts = resolveAllowedHosts(
    pick(flags, '--allowed-hosts', env, 'BRUNO_MCP_ALLOWED_HOSTS'),
    host,
  );
  const idleTimeoutMs = parseIdleTimeout(envValue(env, 'BRUNO_MCP_SESSION_IDLE_MS'));

  return { kind: 'http', host, port, path: '/mcp', tokens, allowedHosts, idleTimeoutMs };
}
