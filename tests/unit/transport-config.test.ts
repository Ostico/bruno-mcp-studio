import {
  DEFAULT_IDLE_TIMEOUT_MS,
  normalizeHostname,
  resolveTransportConfig,
  TransportConfigError,
  USAGE,
  type HttpTransportConfig,
} from '../../src/transport-config';

const TOKEN = 'a'.repeat(31) + 'Z';
const OTHER = 'b'.repeat(40);

function http(argv: string[], env: NodeJS.ProcessEnv = {}, readFile?: (p: string) => string): HttpTransportConfig {
  const config = resolveTransportConfig(argv, { BRUNO_MCP_AUTH_TOKEN: TOKEN, ...env }, readFile);
  if (config.kind !== 'http') throw new Error(`expected http, got ${config.kind}`);
  return config;
}

function errorOf(fn: () => unknown): TransportConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TransportConfigError);
    return error as TransportConfigError;
  }
  throw new Error('expected a TransportConfigError');
}

describe('resolveTransportConfig', () => {
  describe('defaults', () => {
    it('is stdio with no arguments and no environment', () => {
      expect(resolveTransportConfig([], {})).toEqual({ kind: 'stdio', ignoredArgs: [] });
    });

    it('ignores HTTP environment variables under stdio', () => {
      expect(
        resolveTransportConfig([], { BRUNO_MCP_PORT: 'nope', BRUNO_MCP_HOST: '0.0.0.0' }),
      ).toEqual({ kind: 'stdio', ignoredArgs: [] });
    });

    it('binds loopback on 8781 with the loopback hosts allowed', () => {
      expect(http(['--transport', 'http'])).toEqual({
        kind: 'http',
        host: '127.0.0.1',
        port: 8781,
        path: '/mcp',
        tokens: [TOKEN],
        allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      });
    });

    it('selects http from BRUNO_MCP_TRANSPORT, in any case', () => {
      expect(http([], { BRUNO_MCP_TRANSPORT: 'http' }).kind).toBe('http');
      expect(http([], { BRUNO_MCP_TRANSPORT: 'HTTP' }).kind).toBe('http');
      expect(resolveTransportConfig(['--transport', 'Stdio'], {}).kind).toBe('stdio');
    });

    it('ignores unknown arguments under stdio, as 2.5.0 did, and reports them', () => {
      expect(resolveTransportConfig(['--trasport', 'http', 'extra'], {})).toEqual({
        kind: 'stdio',
        ignoredArgs: ['--trasport', 'http', 'extra'],
      });
    });

    it('returns help for -h and --help', () => {
      expect(resolveTransportConfig(['-h'], {})).toEqual({ kind: 'help' });
      expect(resolveTransportConfig(['--help', '--transport', 'http'], {})).toEqual({ kind: 'help' });
      expect(USAGE).toContain('BRUNO_MCP_AUTH_TOKEN');
    });
  });

  describe('precedence', () => {
    it('lets every flag win over its environment variable', () => {
      const config = http(
        ['--transport=http', '--host', '0.0.0.0', '--port=9000', '--allowed-hosts', 'flag.example'],
        {
          BRUNO_MCP_TRANSPORT: 'stdio',
          BRUNO_MCP_HOST: '10.0.0.1',
          BRUNO_MCP_PORT: '7000',
          BRUNO_MCP_ALLOWED_HOSTS: 'env.example',
        },
      );
      expect(config.host).toBe('0.0.0.0');
      expect(config.port).toBe(9000);
      expect(config.allowedHosts).toContain('flag.example');
      expect(config.allowedHosts).not.toContain('env.example');
    });

    it('reads every setting from the environment when no flag is given', () => {
      const config = http([], {
        BRUNO_MCP_TRANSPORT: 'http',
        BRUNO_MCP_HOST: '10.0.0.1',
        BRUNO_MCP_PORT: '7000',
        BRUNO_MCP_ALLOWED_HOSTS: 'Host.Docker.Internal., ::1',
        BRUNO_MCP_SESSION_IDLE_MS: '5000',
      });
      expect(config.host).toBe('10.0.0.1');
      expect(config.port).toBe(7000);
      expect(config.idleTimeoutMs).toBe(5000);
      expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]', '10.0.0.1', 'host.docker.internal']);
    });

    it('treats an empty environment variable as unset', () => {
      const config = http(['--transport', 'http'], { BRUNO_MCP_PORT: '  ', BRUNO_MCP_HOST: '' });
      expect(config.port).toBe(8781);
      expect(config.host).toBe('127.0.0.1');
    });

    it('accepts port 0 to ask for a free port', () => {
      expect(http(['--transport', 'http', '--port', '0']).port).toBe(0);
    });

    it('keeps * and brackets a bare IPv6 bind host', () => {
      const config = http(['--transport', 'http', '--host', '::1', '--allowed-hosts', '*']);
      expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]', '*']);
    });

    it('skips a bind host that is not a hostname', () => {
      const config = http(['--transport', 'http', '--host', 'not a host']);
      expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    });
  });

  describe('tokens', () => {
    it('reads a comma-separated list and drops duplicates', () => {
      expect(http(['--transport', 'http'], { BRUNO_MCP_AUTH_TOKEN: ` ${TOKEN}, ${OTHER},${TOKEN} ,` }).tokens)
        .toEqual([TOKEN, OTHER]);
    });

    it('reads and trims the token file named by the flag, adding to the environment', () => {
      const reads: string[] = [];
      const config = http(['--transport', 'http', '--auth-token-file', '/run/t'], {}, (p) => {
        reads.push(p);
        return `\n  ${OTHER}  \n\n`;
      });
      expect(reads).toEqual(['/run/t']);
      expect(config.tokens).toEqual([TOKEN, OTHER]);
    });

    it('reads the token file named by the environment alone', () => {
      const config = resolveTransportConfig(
        ['--transport', 'http'],
        { BRUNO_MCP_AUTH_TOKEN_FILE: '/run/t' },
        () => `${OTHER}\n`,
      ) as HttpTransportConfig;
      expect(config.tokens).toEqual([OTHER]);
    });

    it('uses the default reader when none is injected', () => {
      const error = errorOf(() =>
        resolveTransportConfig(['--transport', 'http', '--auth-token-file', '/definitely/not/here'], {}),
      );
      expect(error.message).toBe('Cannot read the token file /definitely/not/here (ENOENT)');
    });

    it('reports an unreadable file without a code generically', () => {
      const error = errorOf(() =>
        http(['--transport', 'http', '--auth-token-file', '/t'], {}, () => {
          throw new Error('boom');
        }),
      );
      expect(error.message).toBe('Cannot read the token file /t (unreadable)');
    });

    it('refuses http with no token, naming both variables', () => {
      const error = errorOf(() => resolveTransportConfig(['--transport', 'http'], {}));
      expect(error.message).toContain('BRUNO_MCP_AUTH_TOKEN');
      expect(error.message).toContain('BRUNO_MCP_AUTH_TOKEN_FILE');
    });

    it('refuses http when the variable and the file are both empty', () => {
      const error = errorOf(() =>
        resolveTransportConfig(['--transport', 'http', '--auth-token-file', '/t'], { BRUNO_MCP_AUTH_TOKEN: ' , ' }, () => '\n'),
      );
      expect(error.message).toContain('never starts without one');
    });

    it('refuses a short token without printing it', () => {
      const secret = 'changeme-but-secret';
      const error = errorOf(() => http(['--transport', 'http'], { BRUNO_MCP_AUTH_TOKEN: secret }));
      expect(error.message).toBe(
        `Token 1 from BRUNO_MCP_AUTH_TOKEN is ${secret.length} characters; at least 32 are required`,
      );
      expect(error.message).not.toContain(secret);
    });

    it('refuses a token with a non-ASCII character without printing it', () => {
      const secret = `${'x'.repeat(40)}é`;
      const error = errorOf(() =>
        http(['--transport', 'http', '--auth-token-file', '/t'], {}, () => secret),
      );
      expect(error.message).toBe('Token 1 from token file /t contains whitespace or a non-ASCII character');
      expect(error.message).not.toContain(secret);
    });

    it('refuses --auth-token in both spellings', () => {
      for (const argv of [['--auth-token', TOKEN], [`--auth-token=${TOKEN}`]]) {
        const error = errorOf(() => resolveTransportConfig(argv, {}));
        expect(error.message).toContain('--auth-token is not accepted');
        expect(error.message).not.toContain(TOKEN);
      }
    });
  });

  describe('errors', () => {
    it.each([
      [['--transport', 'grpc'], 'Unknown transport "grpc": use stdio or http'],
      [['--transport', 'http', '--trasport=http'], 'Unknown argument: --trasport=http'],
      [['--transport', 'http', 'extra'], 'Unknown argument: extra'],
      [['--transport'], '--transport needs a value'],
      [['--transport='], '--transport needs a value'],
      [['--transport', '--port', '1'], '--transport needs a value'],
      [['--transport', 'http', '--transport', 'http'], '--transport was given more than once'],
      [['--port', '9000'], '--port only applies to --transport http'],
      [['--transport', 'http', '--port', '65536'], '--port must be an integer from 0 to 65535, got "65536"'],
      [['--transport', 'http', '--port', '-1'], '--port must be an integer from 0 to 65535, got "-1"'],
      [['--transport', 'http', '--port', '80.5'], '--port must be an integer from 0 to 65535, got "80.5"'],
      [['--transport', 'http', '--allowed-hosts', 'evil@localhost'], 'Allowed host "evil@localhost" is not a valid hostname'],
    ])('%j fails with %s', (argv, message) => {
      expect(errorOf(() => http(argv)).message).toBe(message);
    });

    it('names the variable for a bad port from the environment', () => {
      expect(errorOf(() => http(['--transport', 'http'], { BRUNO_MCP_PORT: 'abc' })).message)
        .toBe('BRUNO_MCP_PORT must be an integer from 0 to 65535, got "abc"');
    });

    it.each(['0', '-5', '1.5', 'soon'])('refuses BRUNO_MCP_SESSION_IDLE_MS=%s', (value) => {
      expect(errorOf(() => http(['--transport', 'http'], { BRUNO_MCP_SESSION_IDLE_MS: value })).message)
        .toContain('BRUNO_MCP_SESSION_IDLE_MS must be a positive integer');
    });
  });
});

describe('normalizeHostname', () => {
  it.each([
    ['localhost', 'localhost'],
    ['LOCALHOST:8781', 'localhost'],
    ['localhost.', 'localhost'],
    ['[::1]:8781', '[::1]'],
    ['::1', '[::1]'],
    ['127.0.0.1:80', '127.0.0.1'],
    ['Host.Docker.Internal', 'host.docker.internal'],
  ])('%s is %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each(['', '   ', 'evil@localhost', 'a/b', 'a b', '[::1', '.'])('rejects %j', (input) => {
    expect(normalizeHostname(input)).toBeUndefined();
  });
});
