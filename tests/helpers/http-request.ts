/**
 * Raw HTTP requests for the HTTP transport suites.
 *
 * node:http rather than fetch, for two reasons: fetch will not send a custom
 * Host header, which the Host check tests need, and it goes through undici's
 * process-global dispatcher, which a unit file elsewhere reconfigures, so
 * sharing a jest worker with that file fails at random.
 */

import { request, type ClientRequest, type IncomingMessage } from 'node:http';

export interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface RequestOptions {
  port: number | string;
  /** Defaults to 127.0.0.1. */
  host?: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Send the body yourself, for one that is chunked, oversized or cut short.
   * By default the request is ended with `body`.
   */
  write?: (req: ClientRequest) => void;
}

function open(options: RequestOptions, onResponse: (res: IncomingMessage) => void): ClientRequest {
  const { port, host = '127.0.0.1', method, path, headers = {} } = options;
  // A fresh connection every time: a pooled keep-alive socket that the server
  // has just closed would fail the next request with ECONNRESET.
  return request({ host, port, method, path, headers, agent: false }, onResponse);
}

/**
 * Send one request and resolve with the whole reply. Rejects if the connection
 * fails, so a server that resets instead of answering is a test failure.
 */
export function sendRequest(options: RequestOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = open(options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.write) options.write(req);
    else req.end(options.body);
  });
}

/** Open a request and resolve as soon as its headers arrive, leaving the body streaming. */
export function openStream(options: RequestOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = open(options, (res) => {
      res.on('error', () => undefined);
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Headers every MCP POST needs besides the token. */
export const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

export const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});

export const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
