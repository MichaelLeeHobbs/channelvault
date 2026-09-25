import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backupName, compareVersions, listBackups, saveBackup, serverOfFile, serverSlug, stamp } from '../src/backup/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-backup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const at = (iso: string) => new Date(iso);

describe('naming', () => {
  it('slugs a server name', () => {
    expect(serverSlug('VNS Gov')).toBe('vns-gov');
    expect(serverSlug('  Prod / East #2 ')).toBe('prod-east-2');
  });

  it('files a backup under the server name, else the environment name, else the host', () => {
    expect(backupName({ serverSettings: { serverName: 'VNS Gov', environmentName: 'Production' } }, 'mirth.example.org-8443')).toBe('vns-gov');
    expect(backupName({ serverSettings: { environmentName: 'Production' } }, 'mirth.example.org-8443')).toBe('production');
    expect(backupName({ serverSettings: { serverName: '' } }, 'mirth.example.org-8443')).toBe('mirth-example-org-8443');
  });

  it('stamps in UTC to the second', () => {
    expect(stamp(at('2026-09-25T14:30:12.345Z'))).toBe('20260925T143012Z');
  });

  it('reads the server back from a file name, and only from names it makes', () => {
    expect(serverOfFile('/x/vns-gov-20260925T143012Z.xml')).toBe('vns-gov');
    expect(serverOfFile('/x/vns-gov-20260925T143012Z-2.xml')).toBe('vns-gov');
    expect(serverOfFile('/x/export.xml')).toBeNull();
  });
});

describe('saveBackup', () => {
  it('orders by stamp, numbers a second backup in the same second, and ignores other files', async () => {
    await saveBackup(dir, 'vns-gov', '<b/>', { keep: 10, now: at('2026-09-25T14:30:12Z') });
    await saveBackup(dir, 'vns-gov', '<c/>', { keep: 10, now: at('2026-09-25T14:30:12Z') });
    await saveBackup(dir, 'vns-gov', '<a/>', { keep: 10, now: at('2026-09-24T09:00:00Z') });
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    expect((await listBackups(dir)).map((b) => path.basename(b.file))).toEqual([
      'vns-gov-20260924T090000Z.xml',
      'vns-gov-20260925T143012Z.xml',
      'vns-gov-20260925T143012Z-2.xml',
    ]);
  });

  it("keeps the newest N of one server's backups and leaves other servers' alone", async () => {
    for (let h = 10; h < 14; h += 1) await saveBackup(dir, 'prod', `<p${h}/>`, { keep: 2, now: at(`2026-09-25T${h}:00:00Z`) });
    await saveBackup(dir, 'dev', '<d/>', { keep: 2, now: at('2026-09-25T09:00:00Z') });
    expect((await listBackups(dir)).map((b) => path.basename(b.file))).toEqual([
      'dev-20260925T090000Z.xml',
      'prod-20260925T120000Z.xml',
      'prod-20260925T130000Z.xml',
    ]);
  });

  it('never removes the protected file (the backup being restored)', async () => {
    const restoring = await saveBackup(dir, 'prod', '<old/>', { keep: 1, now: at('2026-09-25T10:00:00Z') });
    await saveBackup(dir, 'prod', '<undo/>', { keep: 1, now: at('2026-09-25T11:00:00Z'), protect: restoring });
    expect(existsSync(restoring)).toBe(true);
  });

  it('makes a directory it creates ignore itself in git, but leaves an existing one alone', async () => {
    const created = path.join(dir, 'new');
    await saveBackup(created, 'prod', '<x/>', { keep: 10 });
    expect(await readFile(path.join(created, '.gitignore'), 'utf8')).toMatch(/^\*$/m);

    const existing = path.join(dir, 'mine');
    await mkdir(existing);
    await saveBackup(existing, 'prod', '<x/>', { keep: 10 });
    expect(await readdir(existing)).not.toContain('.gitignore');
  });

  // POSIX permissions; Windows has no owner-only mode bits to check.
  it.skipIf(process.platform === 'win32')('writes backups readable by the owner only', async () => {
    const file = await saveBackup(dir, 'prod', '<x/>', { keep: 10 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

it('compares versions numerically', () => {
  expect(compareVersions('4.5.2', '4.10.0')).toBeLessThan(0);
  expect(compareVersions('4.5.2', '4.5.2')).toBe(0);
  expect(compareVersions('4.5', '3.12.0')).toBeGreaterThan(0);
});
