import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';
import { runCli } from './helpers/cli.js';

let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-snapshot-'));
  tree = path.join(dir, 'tree');
  mirth = await startFakeMirth({ '@version': '4.5.2', channels: { channel: { id: 'c1', name: 'Alpha', revision: 1, deployScript: 'return;', password: 'fixture-secret-password' } } });
  env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
  const result = await runCli(['pull', tree, '--no-https'], env);
  expect(result.status, result.stderr).toBe(0);
});
afterEach(async () => {
  await mirth?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function snapshot(root: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const file = path.join(rel, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(root, file));
    else out[file] = (await readFile(path.join(root, file))).toString('base64');
  }
  return out;
}

it.each(['pull', 'push', 'adopt'])('preserves the complete tree and writes no server resources on an empty snapshot during %s', async command => {
  const before = await snapshot(tree);
  mirth.onRequest = req => req.path === '/api/server/configuration' ? { status: 200, body: { serverConfiguration: {} } } : undefined;
  const result = await runCli([command, tree, '--no-https', ...(command === 'push' ? ['--yes', '--force'] : command === 'adopt' ? ['--yes'] : [])], env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('invalid server configuration response');
  expect(await snapshot(tree)).toEqual(before);
  expect(mirth.writes).toEqual([]);
});

it('preserves a complete tree on a malformed resource list', async () => {
  const before = await snapshot(tree);
  mirth.onRequest = req => req.path === '/api/server/configuration' ? { status: 200, body: { serverConfiguration: { '@version': '4.5.2', channels: { channel: ['bad'] } } } } : undefined;
  const result = await runCli(['pull', tree, '--no-https'], env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('invalid resource in channels');
  expect(await snapshot(tree)).toEqual(before);
});
