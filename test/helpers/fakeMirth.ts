/**
 * A minimal fake Mirth REST server (plain HTTP) for CLI tests: login, the
 * server configuration, and a record of every write it receives.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CanonicalConfig, Json } from '../../src/types.js';
import { XmlConfigAdapter } from '../../src/xml/index.js';
import { librariesOf, templatesOf } from '../../src/push/index.js';

const xml = new XmlConfigAdapter();

/** Jackson's `@version` metadata as XML attributes (`@_version`), for the XML form of a JSON-shaped config. */
function asXmlShape(value: Json): Json {
  if (Array.isArray(value)) return value.map(asXmlShape);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.startsWith('@') && !k.startsWith('@_') ? `@_${k.slice(1)}` : k, asXmlShape(v)]));
}

export interface FakeRequest { method: string; path: string; body: string; query: Record<string, string> }
/** `body` is sent as JSON; `raw` is sent as-is (plain text, XML). */
export interface FakeResponse { status: number; body?: unknown; raw?: string }
type Obj = Record<string, Json>;

export interface FakeMirth {
  port: number;
  /** Current server configuration (what GET returns). */
  config: CanonicalConfig;
  /** Method and path of every non-GET request after login. */
  writes: FakeRequest[];
  requests: FakeRequest[];
  deployed: Set<string>;
  /** What GET /server/id returns: fixed per installation, untouched by a configuration restore. */
  serverId: string;
  onRequest?: (request: FakeRequest) => FakeResponse | void | Promise<FakeResponse | void>;
  close(): Promise<void>;
}

export async function startFakeMirth(config: CanonicalConfig): Promise<FakeMirth> {
  const state: FakeMirth = { port: 0, config: structuredClone(config), writes: [], requests: [], deployed: new Set(), serverId: randomUUID(), close: async () => undefined };
  const standaloneTemplates = new Map<string, Obj>();
  const rememberTemplates = () => {
    for (const t of librariesOf(state.config).flatMap(templatesOf)) standaloneTemplates.set(String(t.id), t);
  };
  rememberTemplates();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => { void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const request = { method: req.method ?? '', path: url.pathname, body, query: Object.fromEntries(url.searchParams) };
      state.requests.push(request);
      if (url.pathname === '/api/users/_login') {
        res.setHeader('Set-Cookie', 'JSESSIONID=fake; Path=/');
        return json(200, { 'com.mirth.connect.model.LoginStatus': { status: 'SUCCESS', message: null } });
      }
      if (url.pathname === '/api/users/_logout') return json(200, {});
      if (req.method !== 'GET') state.writes.push(request);
      const intercepted = await state.onRequest?.(request);
      if (intercepted?.raw !== undefined) {
        res.writeHead(intercepted.status, { 'Content-Type': 'text/plain' });
        return res.end(intercepted.raw);
      }
      if (intercepted) return json(intercepted.status, intercepted.body ?? {});
      // XML when asked for it, as Mirth does (the backup/restore form).
      const wantsXml = (req.headers.accept ?? '').includes('application/xml');
      const sendsXml = (req.headers['content-type'] ?? '').includes('application/xml');
      if (req.method === 'GET' && url.pathname === '/api/server/id') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(state.serverId);
      }
      if (req.method === 'GET' && url.pathname === '/api/server/configuration') {
        rememberTemplates();
        if (wantsXml) {
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          return res.end(xml.build(asXmlShape(state.config) as CanonicalConfig));
        }
        return json(200, { serverConfiguration: state.config });
      }
      if (req.method === 'PUT' && url.pathname === '/api/server/configuration') {
        const incoming = sendsXml ? xml.parse(body) : (JSON.parse(body) as { serverConfiguration: CanonicalConfig }).serverConfiguration;
        if (url.searchParams.get('overwriteConfigMap') !== 'true') {
          if ('configurationMap' in state.config) incoming.configurationMap = state.config.configurationMap!;
          else delete incoming.configurationMap;
        }
        state.config = incoming;
        return json(200, {});
      }
      if (req.method === 'PUT' && url.pathname === '/api/server/globalScripts') {
        state.config['globalScripts'] = (JSON.parse(body) as { map: Json }).map;
        return json(200, { boolean: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/channels/statuses') {
        return json(200, { list: { dashboardStatus: [...state.deployed].map(channelId => ({ channelId })) } });
      }
      const templateMatch = /^\/api\/codeTemplates\/([^/]+)$/.exec(url.pathname);
      if (templateMatch) {
        rememberTemplates();
        const id = decodeURIComponent(templateMatch[1]!);
        if (req.method === 'GET') return json(200, { codeTemplate: standaloneTemplates.get(id) ?? null });
        if (req.method === 'PUT') {
          const t = (JSON.parse(body) as { codeTemplate: Obj }).codeTemplate;
          t.revision = Number(standaloneTemplates.get(id)?.revision ?? 0) + 1;
          standaloneTemplates.set(id, t);
          for (const lib of librariesOf(state.config)) {
            const members = templatesOf(lib);
            if (members.some(m => m.id === id)) lib.codeTemplates = { codeTemplate: members.map(m => m.id === id ? t : m) };
          }
          return json(200, { boolean: true });
        }
        if (req.method === 'DELETE') {
          standaloneTemplates.delete(id);
          for (const lib of librariesOf(state.config)) lib.codeTemplates = { codeTemplate: templatesOf(lib).filter(t => t.id !== id) };
          return json(200, {});
        }
      }
      if (req.method === 'PUT' && url.pathname === '/api/codeTemplateLibraries') {
        rememberTemplates();
        const before = new Map(librariesOf(state.config).map(l => [String(l.id), l]));
        const libs = (JSON.parse(body) as { list: { codeTemplateLibrary: Obj[] } }).list.codeTemplateLibrary;
        for (const lib of libs) {
          lib.revision = Number(before.get(String(lib.id))?.revision ?? 0) + 1;
          lib.codeTemplates = { codeTemplate: templatesOf(lib).map(t => standaloneTemplates.get(String(t.id)) ?? t) };
        }
        state.config.codeTemplateLibraries = { codeTemplateLibrary: libs };
        return json(200, { boolean: true });
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
