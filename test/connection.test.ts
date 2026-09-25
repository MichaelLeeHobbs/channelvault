/**
 * What a user sees when the server can't be reached, and `diff`'s exit codes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMirthClient, UNTRUSTED_CERT_CODES } from '../src/client/index.js';
import { runCli } from './helpers/cli.js';
import { TEST_CERT, TEST_KEY } from './helpers/selfSignedCert.js';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 'com.mirth.connect.model.LoginStatus': { status: 'SUCCESS', message: null } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A localhost port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const probe = createHttpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const free = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

const login = { username: 'admin', password: 'admin' };

describe('connection errors', () => {
  it('name the address and the reason instead of "fetch failed"', async () => {
    const free = await closedPort();
    const client = createMirthClient({ host: '127.0.0.1', port: free, ...login });
    const error = await client.login().then(() => undefined, (err: unknown) => err as Error & { code?: string });
    await client.close();
    expect(error?.message).toContain(`cannot reach https://127.0.0.1:${free}`);
    expect(error?.message).toContain('ECONNREFUSED');
    expect(error?.code).toBe('ECONNREFUSED');
  });

  it('carry the certificate error code for a self-signed server', async () => {
    const client = createMirthClient({ host: '127.0.0.1', port, ...login });
    const error = await client.login().then(() => undefined, (err: unknown) => err as Error & { code?: string });
    await client.close();
    expect(UNTRUSTED_CERT_CODES.has(error?.code ?? '')).toBe(true);
  });

  it('are absent when certificate verification is off', async () => {
    const client = createMirthClient({ host: '127.0.0.1', port, ...login, disableTlsCheck: true });
    await client.login();
    expect(client.isAuthenticated()).toBe(true);
    await client.close();
  });

  it('come with a hint to use --insecure in the CLI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'channelvault-tls-'));
    try {
      const r = await runCli(['pull', dir], { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(port), MIRTH_USER: 'admin', MIRTH_PASS: 'admin' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`cannot reach https://127.0.0.1:${port}`);
      expect(r.stderr).toContain('pass --insecure');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('diff exit codes', () => {
  // 1 means "differences found", so an error must not use it.
  it('is 2 for an error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'channelvault-diff-exit-'));
    try {
      const r = await runCli(['diff', dir]);
      expect(r.stderr).toContain('not a channelvault tree');
      expect(r.status).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('is 2 for a usage error', async () => {
    const r = await runCli(['diff', 'tree', '--no-such-flag']);
    expect(r.stderr).toContain('unknown option');
    expect(r.status).toBe(2);
  });

  it('is 0 for --help', async () => {
    const r = await runCli(['diff', '--help']);
    expect(r.stdout).toContain('2 = error');
    expect(r.status).toBe(0);
  });
});
