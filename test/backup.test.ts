import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backupName,
  backupsOf,
  compareVersions,
  listBackups,
  MANIFEST,
  numericVersion,
  originOf,
  saveBackup,
  serverOfFile,
  serverSlug,
  stamp,
} from '../src/backup/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-backup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const at = (iso: string) => new Date(iso);
const prod = { serverId: 'id-prod', host: 'prod:8443' };
const staging = { serverId: 'id-staging', host: 'staging:8443' };
const names = (files: Array<{ file: string }>) => files.map((b) => path.basename(b.file));

describe('naming', () => {
  it('slugs a server name', () => {
    expect(serverSlug('VNS Gov')).toBe('vns-gov');
    expect(serverSlug('  Prod / East #2 ')).toBe('prod-east-2');
  });

  it('files a backup under the server name, else the environment name, else the host', () => {
    expect(backupName({ serverSettings: { serverName: 'VNS Gov', environmentName: 'Production' } }, 'mirth.example.org-8443')).toBe('vns-gov');
    expect(backupName({ serverSettings: { environmentName: 'Production' } }, 'mirth.example.org-8443')).toBe('production');
    expect(backupName({ serverSettings: { serverName: '' } }, 'mirth.example.org-8443')).toBe('mirth-example-org-8443');
    // A name with nothing a slug keeps (all non-ASCII) falls back too.
    expect(backupName({ serverSettings: { serverName: 'Сервер' } }, 'mirth.example.org-8443')).toBe('mirth-example-org-8443');
  });

  it('stamps in UTC to the second', () => {
    expect(stamp(at('2026-09-25T14:30:12.345Z'))).toBe('20260925T143012Z');
  });

  it('reads the name back from a file name, including a name that ends in digits', () => {
    expect(serverOfFile('/x/vns-gov-20260925T143012Z.xml')).toBe('vns-gov');
    expect(serverOfFile('/x/prod-2-20260925T143012Z-3.xml')).toBe('prod-2');
    expect(serverOfFile('/x/export.xml')).toBeNull();
  });
});

describe('saveBackup', () => {
  it('orders by stamp, numbers a second backup in the same second, and ignores other files', async () => {
    await saveBackup(dir, 'vns-gov', '<b/>', { keep: 10, origin: prod, now: at('2026-09-25T14:30:12Z') });
    await saveBackup(dir, 'vns-gov', '<c/>', { keep: 10, origin: prod, now: at('2026-09-25T14:30:12Z') });
    await saveBackup(dir, 'vns-gov', '<a/>', { keep: 10, origin: prod, now: at('2026-09-24T09:00:00Z') });
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    expect(names(await listBackups(dir))).toEqual([
      'vns-gov-20260924T090000Z.xml',
      'vns-gov-20260925T143012Z.xml',
      'vns-gov-20260925T143012Z-2.xml',
    ]);
  });

  it("keeps the newest N of one server's backups and leaves other servers' alone", async () => {
    for (let h = 10; h < 14; h += 1) await saveBackup(dir, 'prod', `<p${h}/>`, { keep: 2, origin: prod, now: at(`2026-09-25T${h}:00:00Z`) });
    await saveBackup(dir, 'staging', '<s/>', { keep: 2, origin: staging, now: at('2026-09-25T09:00:00Z') });
    expect(names(await listBackups(dir))).toEqual(['staging-20260925T090000Z.xml', 'prod-20260925T120000Z.xml', 'prod-20260925T130000Z.xml']);
  });

  // The name comes from the configuration, which a restore or whole-server
  // push carries to another server; the server ID does not move.
  it('tells servers apart by ID even when one has taken the other\'s name', async () => {
    await saveBackup(dir, 'prod', '<real prod/>', { keep: 1, origin: prod, now: at('2026-09-25T10:00:00Z') });
    await saveBackup(dir, 'prod', '<staging calling itself prod/>', { keep: 1, origin: staging, now: at('2026-09-25T11:00:00Z') });
    expect(names(await backupsOf(dir, prod.serverId))).toEqual(['prod-20260925T100000Z.xml']);
    expect(names(await backupsOf(dir, staging.serverId))).toEqual(['prod-20260925T110000Z.xml']);
  });

  it('never deletes a file the manifest does not attribute to the server', async () => {
    await writeFile(path.join(dir, 'prod-20200101T000000Z.xml'), '<copied in by hand/>');
    await saveBackup(dir, 'prod', '<x/>', { keep: 1, origin: prod, now: at('2026-09-25T10:00:00Z') });
    await saveBackup(dir, 'prod', '<y/>', { keep: 1, origin: prod, now: at('2026-09-25T11:00:00Z') });
    expect(names(await listBackups(dir))).toEqual(['prod-20200101T000000Z.xml', 'prod-20260925T110000Z.xml']);
  });

  it('never removes the protected file (the backup being restored), however its path is spelled', async () => {
    const restoring = await saveBackup(dir, 'prod', '<old/>', { keep: 1, origin: prod, now: at('2026-09-25T10:00:00Z') });
    // Case differs where the file system ignores case.
    const spelled = process.platform === 'win32' || process.platform === 'darwin' ? restoring.toUpperCase() : restoring;
    await saveBackup(dir, 'prod', '<undo/>', { keep: 1, origin: prod, now: at('2026-09-25T11:00:00Z'), protect: spelled });
    expect(existsSync(restoring)).toBe(true);
  });

  it('records where each backup came from, and only for files in its directory', async () => {
    const file = await saveBackup(dir, 'prod', '<x/>', { keep: 10, origin: prod });
    expect(await originOf(dir, file)).toEqual(prod);
    const elsewhere = path.join(dir, 'sub');
    await mkdir(elsewhere);
    expect(await originOf(dir, path.join(elsewhere, path.basename(file)))).toBeNull();
  });

  it('refuses to guess when the manifest is unreadable', async () => {
    await writeFile(path.join(dir, MANIFEST), '{ not json');
    await expect(backupsOf(dir, prod.serverId)).rejects.toThrow(MANIFEST);
  });

  it('makes a directory it creates ignore itself in git, but leaves an existing one alone', async () => {
    const created = path.join(dir, 'new');
    await saveBackup(created, 'prod', '<x/>', { keep: 10, origin: prod });
    expect(await readFile(path.join(created, '.gitignore'), 'utf8')).toMatch(/^\*$/m);

    const existing = path.join(dir, 'mine');
    await mkdir(existing);
    await saveBackup(existing, 'prod', '<x/>', { keep: 10, origin: prod });
    expect(await readdir(existing)).not.toContain('.gitignore');
  });

  // Mode bits are POSIX; on Windows the file inherits the directory's ACL (documented in the README).
  it.skipIf(process.platform === 'win32')('writes backups readable by the owner only', async () => {
    const file = await saveBackup(dir, 'prod', '<x/>', { keep: 10, origin: prod });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('versions', () => {
  it('compares numerically, ignoring a suffix', () => {
    expect(compareVersions('4.5.2', '4.10.0')).toBeLessThan(0);
    expect(compareVersions('4.5.2', '4.5.2')).toBe(0);
    expect(compareVersions('4.6.0-SNAPSHOT', '4.5.2')).toBeGreaterThan(0);
  });

  it('recognises what it cannot compare', () => {
    expect(numericVersion('4.5.2-SNAPSHOT')).toEqual([4, 5, 2]);
    expect(numericVersion('unknown')).toBeNull();
  });
});
