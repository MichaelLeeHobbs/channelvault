/**
 * The env file may hold the only copy of the secrets, so an update that fails
 * part-way must leave the previous file as it was. The failure is simulated at
 * the final rename, the step after the new content is fully written.
 */
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const failRename = vi.hoisted(() => ({ on: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failRename.on) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
      return actual.rename(...args);
    },
  };
});

const { updateEnvFile } = await import('../src/secrets/envfile.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-atomic-'));
});
afterEach(async () => {
  failRename.on = false;
  await rm(dir, { recursive: true, force: true });
});

it('leaves the previous env file intact and no temp file when the write fails', async () => {
  const file = path.join(dir, '.env');
  await writeFile(file, 'DB_PASSWORD=old\nOTHER=kept\n');
  failRename.on = true;
  await expect(updateEnvFile(file, { DB_PASSWORD: 'new' })).rejects.toThrow('simulated crash');
  expect(await readFile(file, 'utf8')).toBe('DB_PASSWORD=old\nOTHER=kept\n');
  expect(await readdir(dir)).toEqual(['.env']);
});

it('replaces the file when the write succeeds', async () => {
  const file = path.join(dir, '.env');
  await writeFile(file, 'DB_PASSWORD=old\nOTHER=kept\n');
  await updateEnvFile(file, { DB_PASSWORD: 'new' });
  expect(await readFile(file, 'utf8')).toBe('DB_PASSWORD=new\nOTHER=kept\n');
  expect(await readdir(dir)).toEqual(['.env']);
});

// File symlinks need extra privileges on Windows; this runs on Linux CI.
it.skipIf(process.platform === 'win32')('updates the file a symlinked env file points to, keeping the link', async () => {
  const real = path.join(dir, 'shared.env');
  const link = path.join(dir, '.env');
  await writeFile(real, 'DB_PASSWORD=old\n');
  await symlink(real, link);
  await updateEnvFile(link, { DB_PASSWORD: 'new' });
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readFile(real, 'utf8')).toBe('DB_PASSWORD=new\n');
});
