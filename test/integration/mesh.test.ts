/**
 * The mesh fixture (a synthetic, production-shaped routing mesh) on a real
 * Mirth 4.5.2: the rollout checks, where a pull must converge (nothing to push,
 * no diff) before and after scoped pushes, deploys and a restore.
 * Run through `pnpm test:integration`, which owns and removes the servers.
 */
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMirthClient, type MirthClientExt } from '../../src/client/index.js';
import { channelsOf } from '../../src/push/index.js';
import { runCli } from '../helpers/cli.js';

const enabled = process.env.CHANNELVAULT_INTEGRATION === '1';
const port = Number(process.env.CHANNELVAULT_SOURCE_PORT);
const env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(port), MIRTH_USER: 'admin', MIRTH_PASS: 'admin' };

/** Load the fixture as the server's whole configuration, as a restore of it would. */
async function load(xml: string): Promise<void> {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false }, headersTimeout: 300_000 });
  const base = `https://127.0.0.1:${port}/api`;
  const h = { 'X-Requested-With': 'XMLHttpRequest' };
  try {
    // @ts-expect-error Node fetch supports an Undici dispatcher.
    const login = await fetch(`${base}/users/_login`, { method: 'POST', dispatcher, headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=admin' });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    // @ts-expect-error Node fetch supports an Undici dispatcher.
    const r = await fetch(`${base}/server/configuration?deploy=false&overwriteConfigMap=true`, { method: 'PUT', dispatcher, body: xml, headers: { ...h, Cookie: cookie, 'Content-Type': 'application/xml' } });
    expect(r.ok, await r.text()).toBe(true);
  } finally { await dispatcher.close(); }
}

describe.skipIf(!enabled)('the mesh on a disposable Mirth 4.5.2', () => {
  let client: MirthClientExt, work: string, tree: string;
  const cli = (...args: string[]) => runCli([...args, '--insecure'], env);
  const push = (...args: string[]) => cli('push', tree, '--yes', '--backup-dir', path.join(work, 'backups'), ...args);
  const planIsEmpty = async () => {
    const plan = await cli('push', tree, '--plan-only', '--json');
    expect(plan.status, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout).changes).toEqual([]);
    const diff = await cli('diff', tree, '--json');
    expect(diff.status, diff.stdout).toBe(0);
    expect(JSON.parse(diff.stdout).clean).toBe(true);
  };

  beforeAll(async () => {
    if (!Number.isInteger(port)) throw new Error('CHANNELVAULT_SOURCE_PORT is required; use pnpm test:integration');
    await load(await readFile(new URL('../fixtures/serverConfiguration.mesh.xml', import.meta.url), 'utf8'));
    client = createMirthClient({ host: '127.0.0.1', port, username: 'admin', password: 'admin', disableTlsCheck: true });
    await client.login();
    work = await mkdtemp(path.join(tmpdir(), 'channelvault-mesh-live-'));
    tree = path.join(work, 'tree');
  }, 300_000);
  afterAll(async () => {
    if (client) { await client.logout().catch(() => undefined); await client.close(); }
    if (work) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('pulls the mesh and converges: nothing to push, no diff', async () => {
    const refused = await cli('pull', tree);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('db-connection-call');
    const pulled = await cli('pull', tree, '--extract-secrets');
    expect(pulled.status, pulled.stderr).toBe(0);
    expect(await readFile(path.join(tree, 'channels', 'Legacy-Poller', 'source', 'receiver.js'), 'utf8')).not.toContain('Fixture-Legacy-Pw1');
    await planIsEmpty();
  }, 180_000);

  it('pushes a step of the 18-destination hub and redeploys it, then converges', async () => {
    await client.deployChannel(channelsOf(await client.getServerConfiguration()).find((c) => c['name'] === 'Order Hub')!['id'] as string);
    await appendFile(path.join(tree, 'channels', 'Order-Hub', 'source', 'transformer', '1.Route-by-type.js'), '\n// reviewed');
    const pushed = await push('--channel', 'Order Hub', '--deploy');
    expect(pushed.status, pushed.stdout + pushed.stderr).toBe(0);
    expect(pushed.stdout).toMatch(/update\s+channel Order Hub\n/);
    expect(pushed.stdout).toContain('deployed 1 of 1 channel(s)');
    await planIsEmpty();
  }, 180_000);

  it('pushes a change to the 10,000-line code template, then converges', async () => {
    await appendFile(path.join(tree, 'codeTemplates', 'Lookup', 'lookupCode.js'), '\n// reviewed');
    const pushed = await push('--library', 'Lookup');
    expect(pushed.status, pushed.stdout + pushed.stderr).toBe(0);
    expect(pushed.stdout).toMatch(/update\s+code template Lookup\/lookupCode\n/);
    await planIsEmpty();
  }, 180_000);

  it('backs up, loses a site channel, and restores it', async () => {
    const backupDir = path.join(work, 'manual-backups');
    expect((await cli('backup', '--backup-dir', backupDir)).status).toBe(0);
    const site = channelsOf(await client.getServerConfiguration()).find((c) => c['name'] === 'Site East 03')!;
    await client.deleteChannel(site['id'] as string);
    const restored = await cli('restore', '--yes', '--backup-dir', backupDir);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(channelsOf(await client.getServerConfiguration()).map((c) => c['name'])).toContain('Site East 03');
    await planIsEmpty();
  }, 300_000);
});
