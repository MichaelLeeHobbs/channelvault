import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createMirthClient } from '../src/client/index.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string> }): Promise<number> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const { status, headers } = handler(req, body);
      res.writeHead(status, headers);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('redirects', () => {
  // A followed 307 re-posts the login form, password included, to the Location host.
  it.each([301, 302, 307, 308])('never follows a %i on login, so the password stays with the server it was meant for', async (status) => {
    const elsewhere: string[] = [];
    const otherPort = await listen((req, body) => {
      elsewhere.push(`${req.method} ${req.url} ${body}`);
      return { status: 200 };
    });
    const port = await listen(() => ({ status, headers: { Location: `http://127.0.0.1:${otherPort}/collect?token=abc` } }));
    const client = createMirthClient({ host: '127.0.0.1', port, username: 'admin', password: 'Hunter2Secret', https: false });
    try {
      const error = await client.login().then(() => undefined, (err: unknown) => err as Error);
      expect(error?.message).toContain(`redirect (HTTP ${status}, to http://127.0.0.1:${otherPort})`);
      expect(error?.message).not.toContain('token=abc');
      expect(elsewhere).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
