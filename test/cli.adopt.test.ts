import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { channelsOf } from '../src/push/index.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';
import { runCli, startCli } from './helpers/cli.js';

let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-adopt-'));
  tree = path.join(dir, 'tree');
  mirth = await startFakeMirth({ '@version': '4.5.2', channels: { channel: [
    { id: 'c1', name: 'Alpha', revision: 10, deployScript: 'return;', password: 'fixture-secret-password' },
    { id: 'c2', name: 'Beta', revision: 10, deployScript: 'return;' },
  ] } });
  env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
  const pull = await runCli(['pull', tree, '--no-https'], env);
  expect(pull.status, pull.stderr).toBe(0);
});
afterEach(async () => {
  await mirth?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const file = () => path.join(tree, 'channelvault.json');
const script = () => path.join(tree, 'channels', 'Alpha', 'scripts', 'deploy.js');
const run = (...args: string[]) => runCli([...args, '--no-https'], env);
const push = (...flags: string[]) => run('push', tree, '--yes', '--backup-dir', path.join(dir, 'backups'), ...flags);

it.each([1, 10])('refuses another installation even at equal or lower revision %s, with force too', async revision => {
  await writeFile(script(), 'localEdit();');
  mirth.serverId = randomUUID();
  channelsOf(mirth.config)[0]!.revision = revision;
  channelsOf(mirth.config)[0]!.deployScript = 'targetEdit();';
  for (const flags of [[], ['--force'], ['--force', '--whole-server']]) {
    const result = await push(...flags);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--force does not bypass installation binding');
  }
  const plan = await run('push', tree, '--plan-only', '--json', '--force');
  expect(plan.status, plan.stderr).toBe(0);
  expect(JSON.parse(plan.stdout).wouldStop.join(' ')).toContain('baseline belongs to installation');
  expect(mirth.writes).toEqual([]);
  expect(channelsOf(mirth.config)[0]!.deployScript).toBe('targetEdit();');
});

it('adopts a reviewed target without writes or secret changes, then pushes and converges', async () => {
  await writeFile(script(), 'localEdit();');
  mirth.serverId = randomUUID();
  channelsOf(mirth.config)[0]!.revision = 2;
  mirth.config.channels = { channel: [...channelsOf(mirth.config), { id: 'c9', name: 'Target Only', revision: 3 }] };
  const beforeMeta = await readFile(file(), 'utf8');
  const beforeEnv = await readFile(path.join(tree, '.env'), 'utf8');
  const preview = await run('adopt', tree, '--plan-only', '--json');
  expect(preview.status, preview.stderr).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ mode: 'adopt', wouldStop: [], serverOnly: ['channel "Target Only"'] });
  expect(await readFile(file(), 'utf8')).toBe(beforeMeta);
  const adopted = await run('adopt', tree, '--yes');
  expect(adopted.status, adopted.stderr).toBe(0);
  expect(mirth.writes).toEqual([]);
  expect(await readFile(script(), 'utf8')).toBe('localEdit();');
  expect(await readFile(path.join(tree, '.env'), 'utf8')).toBe(beforeEnv);
  expect(await readFile(path.join(tree, 'channels', 'Alpha', 'channel.json'), 'utf8')).toContain('{{env:');
  const meta = JSON.parse(await readFile(file(), 'utf8'));
  expect(meta.serverId).toBe(mirth.serverId);
  expect(meta.resources.channels).toEqual({ c1: 2, c2: 10 });
  expect((await push('--channel', 'Alpha')).status).toBe(0);
  expect(channelsOf(mirth.config)[0]!.deployScript).toBe('localEdit();');
  expect(channelsOf(mirth.config).map(c => c.id)).toContain('c9');
  mirth.writes.length = 0;
  expect((await push('--channel', 'Alpha')).stdout).toContain('nothing to push');
  expect(mirth.writes).toEqual([]);
});

it('protects independent edits made after adoption', async () => {
  await writeFile(script(), 'localEdit();');
  mirth.serverId = randomUUID();
  channelsOf(mirth.config)[0]!.revision = 2;
  expect((await run('adopt', tree, '--yes')).status).toBe(0);
  channelsOf(mirth.config)[0]!.revision = 3;
  channelsOf(mirth.config)[0]!.deployScript = 'peerEdit();';
  const result = await push();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('server revision 3, tree 2');
  expect(mirth.writes).toEqual([]);
});

it('refuses an unknown legacy baseline until it is explicitly adopted', async () => {
  await writeFile(script(), 'localEdit();');
  const meta = JSON.parse(await readFile(file(), 'utf8'));
  delete meta.serverId;
  await writeFile(file(), JSON.stringify(meta));
  const result = await push('--force');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unknown installation');
  expect(mirth.writes).toEqual([]);
  expect((await run('adopt', tree, '--yes')).status).toBe(0);
  expect((await push()).status).toBe(0);
});

it('uses the installation ID rather than the stored URL', async () => {
  const meta = JSON.parse(await readFile(file(), 'utf8'));
  meta.source = 'https://another-alias.example:8443';
  await writeFile(file(), JSON.stringify(meta));
  await writeFile(script(), 'localEdit();');
  expect((await push()).status).toBe(0);
});

it('refuses adoption when the target changes during confirmation', async () => {
  const before = await readFile(file(), 'utf8');
  const running = startCli(['adopt', tree, '--no-https'], env, true);
  try {
    await running.waitFor('Accept this baseline?');
    channelsOf(mirth.config)[0]!.deployScript = 'peerEdit();';
    running.child.stdin.end('y\n');
    const result = await running.finished;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('target changed while adopting');
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect(mirth.writes).toEqual([]);
  } finally { running.child.kill(); }
});

it('preserves an edit made to the local tree while adoption is being confirmed', async () => {
  const before = await readFile(file(), 'utf8');
  const running = startCli(['adopt', tree, '--no-https'], env, true);
  try {
    await running.waitFor('Accept this baseline?');
    await writeFile(script(), 'newLocalEdit();');
    running.child.stdin.end('y\n');
    const result = await running.finished;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local tree changed while adopting');
    expect(await readFile(script(), 'utf8')).toBe('newLocalEdit();');
    expect(await readFile(file(), 'utf8')).toBe(before);
  } finally { running.child.kill(); }
});

it('refuses a pull when installation identity changes during its snapshot', async () => {
  const before = await readFile(file(), 'utf8');
  let reads = 0;
  mirth.onRequest = req => { if (req.path === '/api/server/id' && ++reads === 2) mirth.serverId = randomUUID(); };
  const result = await run('pull', tree);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('installation changed while pulling');
  expect(await readFile(file(), 'utf8')).toBe(before);
});

it('rechecks installation identity after backup even with force', async () => {
  await writeFile(script(), 'localEdit();');
  let reads = 0;
  mirth.onRequest = req => { if (req.path === '/api/server/id' && ++reads === 2) mirth.serverId = randomUUID(); };
  const result = await push('--force');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('installation binding');
  expect(mirth.writes).toEqual([]);
});
