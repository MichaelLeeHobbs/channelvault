import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ target: '', remaining: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => {
    if (failure.remaining > 0 && (to === failure.target || (failure.target.endsWith('outside.env') && path.basename(to) === 'outside.env'))) {
      failure.remaining--;
      throw Object.assign(new Error('injected rename failure'), { code: 'EPERM' });
    }
    return actual.rename(from, to);
  } };
});
const { JOURNAL, lockTree, recoverTree, replaceTree, STAGING_DIR } = await import('../src/tree/transaction.js');
const { createExplodeEngine } = await import('../src/explode/index.js');
let dir: string, root: string, env: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-transaction-'));
  root = path.join(dir, 'tree'); env = path.join(dir, 'outside.env');
  await generation(root, 'old'); await writeFile(env, 'old-secret', { mode: 0o600 });
});
afterEach(async () => { failure.remaining = 0; await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
async function generation(next: string, label: string) {
  for (const name of ['server', 'channels', 'codeTemplates', 'channelGroups', '.secrets']) {
    await mkdir(path.join(next, name), { recursive: true });
    await writeFile(path.join(next, name, 'data'), label);
  }
  for (const name of ['channelvault.json', '.gitignore']) await writeFile(path.join(next, name), label);
}
async function prepare(next: string) { await generation(next, 'new'); await writeFile(path.join(next, '.env'), 'new-secret', { mode: 0o600 }); }
async function expectGeneration(label: string) {
  for (const name of ['server', 'channels', 'codeTemplates', 'channelGroups', '.secrets']) expect(await readFile(path.join(root, name, 'data'), 'utf8')).toBe(label);
  for (const name of ['channelvault.json', '.gitignore']) expect(await readFile(path.join(root, name), 'utf8')).toBe(label);
  expect(await readFile(env, 'utf8')).toBe(`${label}-secret`);
}
it.each(['server', 'channels', 'codeTemplates', 'channelGroups', 'channelvault.json', '.gitignore', '.secrets', 'env'])('rolls back the whole generation after a failed %s swap', async name => {
  failure.target = name === 'env' ? env : path.join(root, name); failure.remaining = 6;
  await expect(replaceTree(root, env, prepare)).rejects.toThrow('injected rename failure');
  await expectGeneration('old');
  expect(existsSync(path.join(root, STAGING_DIR))).toBe(false);
  expect(existsSync(path.join(root, JOURNAL))).toBe(false);
  expect((await readdir(dir)).sort()).toEqual(['outside.env', 'tree']);
});
it('commits configuration, metadata, ignore rules, history and an external env file together', async () => {
  await replaceTree(root, env, prepare); await expectGeneration('new');
  expect((await readdir(dir)).sort()).toEqual(['outside.env', 'tree']);
});
it('leaves the previous generation intact when preparation fails', async () => {
  await expect(replaceTree(root, env, async next => { await prepare(next); throw new Error('prepare failed'); })).rejects.toThrow('prepare failed');
  await expectGeneration('old');
});
it('blocks another command while the tree lock is held', async () => {
  const release = await lockTree(root);
  try { await expect(lockTree(root)).rejects.toThrow('working tree is locked'); }
  finally { await release(); }
  const again = await lockTree(root); await again();
});
it('refuses a staging junction without changing its target', async () => {
  const outside = path.join(dir, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'keep');
  await symlink(outside, path.join(root, STAGING_DIR), 'junction');
  await expect(replaceTree(root, env, prepare)).rejects.toThrow('linked staging directory');
  expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep');
  await expectGeneration('old');
});
it.each(['channels', 'outside.env', JOURNAL])('recovers a process killed during the %s swap', async checkpoint => {
  // Patch the builtin before importing the transaction, then terminate after
  // a real rename. No catch/finally runs, so this exercises persisted recovery.
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    const root = process.argv[1], env = process.argv[2], checkpoint = process.argv[3];
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      await rename(from, to);
      if ((from.includes('.channelvault-staging') && path.basename(to) === checkpoint) ||
          (checkpoint === 'outside.env' && path.basename(to) === path.basename(env)) ||
          (checkpoint === '.channelvault-transaction.json' && to.endsWith(checkpoint) && JSON.parse(await fs.readFile(to, 'utf8')).state === 'committed')) process.exit(86);
    };
    syncBuiltinESMExports();
    const tx = await import('./src/tree/transaction.ts');
    await tx.lockTree(root);
    await tx.replaceTree(root, env, async next => {
      for (const name of ['server', 'channels', 'codeTemplates', 'channelGroups', '.secrets']) {
        await fs.mkdir(path.join(next, name), { recursive: true }); await fs.writeFile(path.join(next, name, 'data'), 'new');
      }
      for (const name of ['channelvault.json', '.gitignore']) await fs.writeFile(path.join(next, name), 'new');
      await fs.writeFile(path.join(next, '.env'), 'new-secret', { mode: 0o600 });
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, env, checkpoint]);
  let stderr = ''; child.stderr.on('data', b => { stderr += b.toString(); });
  expect(await new Promise(resolve => child.on('close', resolve)), stderr).toBe(86);
  await expect(createExplodeEngine().implode({ root })).rejects.toThrow('pending replacement');
  const release = await lockTree(root);
  try { await recoverTree(root, env); await recoverTree(root, env); }
  finally { await release(); }
  await expectGeneration(checkpoint === JOURNAL ? 'new' : 'old');
  expect(existsSync(path.join(root, JOURNAL))).toBe(false);
});
