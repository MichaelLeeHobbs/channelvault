/**
 * A minimal fake Mirth REST server (plain HTTP) for CLI tests: login, the
 * server configuration, and a record of every write it receives.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CanonicalConfig } from '../../src/types.js';

export interface FakeMirth {
  port: number;
  /** Current server configuration (what GET returns). */
  config: CanonicalConfig;
  /** Method and path of every non-GET request after login. */
  writes: Array<{ method: string; path: string; body: string }>;
  close(): Promise<void>;
}

export async function startFakeMirth(config: CanonicalConfig): Promise<FakeMirth> {
  const state: FakeMirth = { port: 0, config, writes: [], close: async () => undefined };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === '/api/users/_login') {
        res.setHeader('Set-Cookie', 'JSESSIONID=fake; Path=/');
        return json(200, { 'com.mirth.connect.model.LoginStatus': { status: 'SUCCESS', message: null } });
      }
      if (url.pathname === '/api/users/_logout') return json(200, {});
      if (req.method === 'GET' && url.pathname === '/api/server/configuration') {
        return json(200, { serverConfiguration: state.config });
      }
      state.writes.push({ method: req.method ?? '', path: url.pathname, body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
