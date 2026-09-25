/**
 * A minimal fake Mirth REST server (plain HTTP) for CLI tests: login, the
 * server configuration, and a record of every write it receives.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CanonicalConfig, Json } from '../../src/types.js';

export interface FakeRequest { method: string; path: string; body: string }
export interface FakeResponse { status: number; body?: unknown }
type Obj = Record<string, Json>;

export interface FakeMirth {
  port: number;
  /** Current server configuration (what GET returns). */
  config: CanonicalConfig;
  /** Method and path of every non-GET request after login. */
  writes: FakeRequest[];
  requests: FakeRequest[];
  deployed: Set<string>;
  onRequest?: (request: FakeRequest) => FakeResponse | void | Promise<FakeResponse | void>;
  close(): Promise<void>;
}

export async function startFakeMirth(config: CanonicalConfig): Promise<FakeMirth> {
  const state: FakeMirth = { port: 0, config: structuredClone(config), writes: [], requests: [], deployed: new Set(), close: async () => undefined };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => { void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const request = { method: req.method ?? '', path: url.pathname, body };
      state.requests.push(request);
      if (url.pathname === '/api/users/_login') {
        res.setHeader('Set-Cookie', 'JSESSIONID=fake; Path=/');
        return json(200, { 'com.mirth.connect.model.LoginStatus': { status: 'SUCCESS', message: null } });
      }
      if (url.pathname === '/api/users/_logout') return json(200, {});
      if (req.method !== 'GET') state.writes.push(request);
      const intercepted = await state.onRequest?.(request);
      if (intercepted) return json(intercepted.status, intercepted.body ?? {});
      if (req.method === 'GET' && url.pathname === '/api/server/configuration') {
        return json(200, { serverConfiguration: state.config });
      }
      if (req.method === 'PUT' && url.pathname === '/api/server/configuration') {
        state.config = (JSON.parse(body) as { serverConfiguration: CanonicalConfig }).serverConfiguration;
        return json(200, {});
      }
      if (req.method === 'PUT' && url.pathname === '/api/server/globalScripts') {
        state.config['globalScripts'] = (JSON.parse(body) as { map: Json }).map;
        return json(200, { boolean: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/channels/statuses') {
        return json(200, { list: { dashboardStatus: [...state.deployed].map(channelId => ({ channelId })) } });
      }
      const match = /^\/api\/channels\/([^/]+)(\/_deploy)?$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        const container = state.config['channels'] as Obj;
        const raw = container?.['channel'];
        const channels = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Obj[];
        const index = channels.findIndex(c => c['id'] === id);
        if (match[2] && req.method === 'POST') {
          if (index < 0) return json(404, { error: 'No such channel' });
          state.deployed.add(id);
          return json(200, {});
        }
        if (req.method === 'GET') return json(200, { channel: channels[index] ?? null });
        if (req.method === 'PUT') {
          const channel = (JSON.parse(body) as { channel: Obj }).channel;
          channel['revision'] = Number(channels[index]?.['revision'] ?? 0) + 1;
          if (index < 0) channels.push(channel);
          else channels[index] = channel;
          state.config['channels'] = { channel: channels };
          return json(200, { boolean: true });
        }
        if (req.method === 'DELETE') {
          state.config['channels'] = { channel: channels.filter(c => c['id'] !== id) };
          state.deployed.delete(id);
          return json(200, {});
        }
      }
      return json(404, { error: `Unhandled fake endpoint: ${request.method} ${request.path}` });
    })().catch(error => {
      res.writeHead(500);
      res.end(String(error));
    }); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return state;
}
