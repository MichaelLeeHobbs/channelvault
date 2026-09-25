/** Run through `pnpm test:integration`, which owns and removes both servers. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMirthClient, type MirthClientExt } from '../../src/client/index.js';
import { createExplodeEngine } from '../../src/explode/index.js';
import { channelsOf } from '../../src/push/index.js';
import { readEnvFile, updateEnvFile } from '../../src/secrets/envfile.js';
import { XmlConfigAdapter } from '../../src/xml/index.js';
import type { Json } from '../../src/types.js';
import { runCli } from '../helpers/cli.js';

type Obj = Record<string, Json>;
const enabled = process.env.CHANNELVAULT_INTEGRATION === '1';
const sourcePort = Number(process.env.CHANNELVAULT_SOURCE_PORT);
const targetPort = Number(process.env.CHANNELVAULT_TARGET_PORT);
const sourcePassword = 'source-fixture-password';
const targetPassword = 'target-fixture-password';
const selectedName = 'Report Distributor';
const selectedId = '00000000-0000-4000-8000-000000000005';
const env = (port: number) => ({ MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(port), MIRTH_USER: 'admin', MIRTH_PASS: 'admin' });

async function seed(port: number, password: string): Promise<void> {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const base = `https://127.0.0.1:${port}/api`;
  try {
    const response = await fetch(`${base}/users/_login`, {
      method: 'POST', body: new URLSearchParams({ username: 'admin', password: 'admin' }),
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      // @ts-expect-error Node fetch supports an Undici dispatcher.
      dispatcher,
    });
    expect(response.ok).toBe(true);
    expect(await response.text()).toContain('SUCCESS');
    const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    expect(cookie).toContain('JSESSIONID=');
    const xml = (await readFile(new URL('../fixtures/serverConfiguration.sample.xml', import.meta.url), 'utf8'))
      .replaceAll('fixture-password', password)
      .replace(/(<channelTags>[\s\S]*?<channelIds>)/, `$1<string>${selectedId}</string>`);
    const imported = await fetch(`${base}/server/configuration?deploy=false&overwriteConfigMap=true`, {
      method: 'PUT', body: xml,
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/xml', Cookie: cookie },
      // @ts-expect-error Node fetch supports an Undici dispatcher.
      dispatcher,
    });
    expect(imported.ok, await imported.text()).toBe(true);
    const logout = await fetch(`${base}/users/_logout`, {
      method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie },
      // @ts-expect-error Node fetch supports an Undici dispatcher.
      dispatcher,
    });
    await logout.text();
  } finally { await dispatcher.close(); }
}

describe.skipIf(!enabled)('two disposable Mirth 4.5.2 servers', () => {
  let source: MirthClientExt, target: MirthClientExt, work: string;
  beforeAll(async () => {
    if (!Number.isInteger(sourcePort) || !Number.isInteger(targetPort) || sourcePort === targetPort) {
      throw new Error('Two distinct test ports are required; use pnpm test:integration');
    }
    await Promise.all([seed(sourcePort, sourcePassword), seed(targetPort, targetPassword)]);
    const client = (port: number) => createMirthClient({ host: '127.0.0.1', port, username: 'admin', password: 'admin', disableTlsCheck: true });
    source = client(sourcePort);
    target = client(targetPort);
    await Promise.all([source.login(), target.login()]);
    work = await mkdtemp(path.join(tmpdir(), 'channelvault-promotion-'));
  }, 120_000);
  afterAll(async () => {
    for (const client of [source, target]) if (client) {
      await client.logout().catch(() => undefined);
      await client.close();
    }
    if (work) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('round-trips a nonempty real API response through the filesystem projection', async () => {
    const config = await source.getServerConfiguration();
    expect(channelsOf(config)).toHaveLength(5);
    const engine = createExplodeEngine();
    const root = path.join(work, 'roundtrip');
    await engine.explode(config, { root });
    expect(await engine.implode({ root })).toEqual(config);
  }, 60_000);

  it('promotes a channel with destination credentials, protects target revisions, and converges after push', async () => {
    const sourceTree = path.join(work, 'source');
    const targetTree = path.join(work, 'target');
    const pull = await runCli(['pull', sourceTree, '--insecure'], env(sourcePort));
    expect(pull.status, pull.stderr).toBe(0);
    const initial = await source.getServerConfiguration();
    const selected = channelsOf(initial).find(c => c['name'] === selectedName)!;
    expect(selected).toBeDefined();
    const id = String(selected['id']);
    expect(id).toBe(selectedId);
    const untouchedId = String(channelsOf(initial).find(c => c['id'] !== id)!['id']);
    const sourceBefore = await source.getChannel(id);
    const untouchedBefore = await target.getChannel(untouchedId);
    const scriptPath = path.join(sourceTree, 'channels', 'Report-Distributor', 'scripts', 'deploy.js');
    const promotedCode = `// promoted by the integration test\n${String(selected['deployScript'])}`;
    await writeFile(scriptPath, promotedCode);
    await cp(sourceTree, targetTree, { recursive: true });
    const values = await readEnvFile(path.join(sourceTree, '.env'));
    expect(Object.values(values)).toContain(sourcePassword);
    const destinationEnv = path.join(work, 'destination.env');
    await updateEnvFile(destinationEnv, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === sourcePassword ? targetPassword : v])));

    const destination = (await target.getChannel(id))!;
    destination['description'] = 'Changed independently on the destination';
    for (let i = 0; i < 3; i++) await target.putChannel(destination);
    const targetBefore = await target.getChannel(id);
    const tagsBefore = (targetBefore!['exportData'] as Obj)['channelTags'];
    expect(JSON.stringify(tagsBefore)).toContain('Sample');
    expect(Number(targetBefore!['revision'])).toBeGreaterThan(Number(selected['revision']));
    const args = ['push', targetTree, '--insecure', '--yes', '--channel', selectedName, '--dotenv', destinationEnv, '--backup-dir', path.join(work, 'backups')];
    const refused = await runCli(args, env(targetPort));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('server revision');
    expect(await target.getChannel(id)).toEqual(targetBefore);
    const pushed = await runCli([...args, '--force'], env(targetPort));
    expect(pushed.status, pushed.stderr).toBe(0);
    const promoted = (await target.getChannel(id))!;
    expect(promoted['deployScript']).toBe(promotedCode.replace(/\r\n?/g, '\n'));
    const connectors = (promoted['destinationConnectors'] as Obj)['connector'] as Obj[];
    const smtp = connectors.find(c => c['name'] === 'To SMTP Sender')!;
    expect((smtp['properties'] as Obj)['password']).toBe(targetPassword);
    expect(JSON.stringify(promoted)).not.toContain(sourcePassword);
    expect((promoted['exportData'] as Obj)['channelTags']).toEqual(tagsBefore);
    expect(await target.getChannel(untouchedId)).toEqual(untouchedBefore);
    expect(await source.getChannel(id)).toEqual(sourceBefore);
    expect(await target.getDeployedChannelIds()).toEqual(new Set());

    const repeat = await runCli(args, env(targetPort));
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(repeat.stdout).toContain('nothing to push');
    const targetPull = await runCli(['pull', path.join(work, 'target-observed'), '--insecure'], env(targetPort));
    expect(targetPull.status, targetPull.stderr).toBe(0);
    const diff = await runCli(['diff', path.join(work, 'target-observed'), '--insecure'], env(targetPort));
    expect(diff.status, diff.stdout + diff.stderr).toBe(0);
    expect(diff.stdout).toContain('no differences');
  }, 120_000);

  it('backs up the server and restores it after a channel is deleted', async () => {
    const backupDir = path.join(work, 'source-backups');
    const backedUp = await runCli(['backup', '--insecure', '--backup-dir', backupDir], env(sourcePort));
    expect(backedUp.status, backedUp.stderr).toBe(0);
    const before = channelsOf(await source.getServerConfiguration()).map(c => String(c['id'])).sort();

    await source.deleteChannel(selectedId);
    expect(channelsOf(await source.getServerConfiguration()).map(c => String(c['id']))).not.toContain(selectedId);

    // The newest backup of this server; restore checks the result matches it.
    const restored = await runCli(['restore', '--insecure', '--yes', '--backup-dir', backupDir], env(sourcePort));
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(restored.stdout).toMatch(/create\s+channel Report Distributor\n/);
    expect(channelsOf(await source.getServerConfiguration()).map(c => String(c['id'])).sort()).toEqual(before);

    // The undo backup is the server as it was without the channel.
    const undo = /saved the current configuration to (.+?) \(undo/.exec(restored.stdout)?.[1];
    expect(undo).toBeDefined();
    // (Its id still appears in tags and library settings, which outlive the channel.)
    const undone = new XmlConfigAdapter().parse(await readFile(undo!, 'utf8'));
    expect(channelsOf(undone).map(c => String(c['id']))).not.toContain(selectedId);
    expect(channelsOf(undone)).toHaveLength(before.length - 1);
  }, 120_000);
});
