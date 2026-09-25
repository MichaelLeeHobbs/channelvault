import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanonicalConfig } from '../src/types.js';
import { XmlConfigAdapter } from '../src/xml/index.js';
import { runCli } from './helpers/cli.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';

const xml = new XmlConfigAdapter();

/** An XML-shaped server configuration, as a backup holds it. */
function serverXml(opts: { name?: string; channels: string[]; version?: string }): string {
  const version = opts.version ?? '4.5.2';
  const channels = opts.channels
    .map((n, i) => `<channel version="${version}"><id>c${i + 1}</id><name>${n}</name><revision>1</revision></channel>`)
    .join('');
  const name = opts.name === undefined ? '' : `<serverName>${opts.name}</serverName>`;
  return `<serverConfiguration version="${version}"><channels>${channels}</channels><serverSettings>${name}</serverSettings></serverConfiguration>`;
}
const config = (opts: Parameters<typeof serverXml>[0]): CanonicalConfig => xml.parse(serverXml(opts));
const channelNames = (c: CanonicalConfig): string[] =>
  (((c['channels'] as Record<string, unknown>)['channel'] ?? []) as Array<Record<string, unknown>>).map((ch) => String(ch['name']));

let dir: string, backups: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-cli-backup-'));
  backups = path.join(dir, 'backups');
  mirth = await startFakeMirth(config({ name: 'VNS Gov', channels: ['Alpha', 'Beta'] }));
  env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
});
afterEach(async () => {
  await mirth?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const cli = (...args: string[]) => runCli([...args, '--no-https', '--backup-dir', backups], env);
const files = async () => (existsSync(backups) ? (await readdir(backups)).filter((f) => f.endsWith('.xml')).sort() : []);

describe('backup', () => {
  it('saves the server XML as <server name>-<UTC stamp>.xml', async () => {
    const r = await cli('backup');
    expect(r.status, r.stderr).toBe(0);
    const [file] = await files();
    expect(file).toMatch(/^vns-gov-\d{8}T\d{6}Z\.xml$/);
    expect(xml.parse(await readFile(path.join(backups, file!), 'utf8'))).toEqual(mirth.config);
    expect(r.stdout).toContain(path.join(backups, file!));
  });

  it('falls back to the host and port for a server with no name', async () => {
    mirth.config = config({ channels: ['Alpha'] });
    expect((await cli('backup')).status).toBe(0);
    expect(await files()).toEqual([expect.stringMatching(new RegExp(`^127-0-0-1-${mirth.port}-\\d{8}T\\d{6}Z\\.xml$`))]);
  });

  it('writes --out exactly, and never over an existing file', async () => {
    const out = path.join(dir, 'exports', 'before-upgrade.xml');
    expect((await cli('backup', '--out', out)).status).toBe(0);
    expect(xml.parse(await readFile(out, 'utf8'))).toEqual(mirth.config);
    const again = await cli('backup', '--out', out);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already exists');
  });
});

describe('restore', () => {
  /** A backup file of `server` at `stamp` with these channels. */
  async function backupFile(server: string, stamp: string, channels: string[], opts: { name?: string; version?: string } = {}): Promise<string> {
    await mkdir(backups, { recursive: true });
    const file = path.join(backups, `${server}-${stamp}.xml`);
    await writeFile(file, serverXml({ name: opts.name ?? 'VNS Gov', channels, version: opts.version }));
    return file;
  }

  it("restores this server's newest backup, not a newer one of another server, keeping an undo backup", async () => {
    await backupFile('vns-gov', '20260920T100000Z', ['Old']);
    await backupFile('vns-gov', '20260921T100000Z', ['Alpha']);
    await backupFile('vns-dev', '20260922T100000Z', ['Dev Only'], { name: 'VNS Dev' });
    const r = await cli('restore', '--yes');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('vns-gov-20260921T100000Z.xml');
    expect(r.stdout).toMatch(/delete\s+channel Beta\n/);
    expect(channelNames(mirth.config)).toEqual(['Alpha']);
    // The configuration it replaced, kept as the newest backup.
    const undo = (await files()).filter((f) => f.startsWith('vns-gov-')).at(-1)!;
    expect(channelNames(xml.parse(await readFile(path.join(backups, undo), 'utf8')))).toEqual(['Alpha', 'Beta']);
    expect(r.stdout).toContain(`channelvault restore "${path.join(backups, undo)}"`);
  });

  it('refuses a backup of another server unless forced', async () => {
    const other = await backupFile('vns-dev', '20260922T100000Z', ['Dev Only'], { name: 'VNS Dev' });
    const refused = await cli('restore', other, '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('is a backup of vns-dev, not vns-gov');
    expect(channelNames(mirth.config)).toEqual(['Alpha', 'Beta']);

    const forced = await cli('restore', other, '--yes', '--force');
    expect(forced.status, forced.stderr).toBe(0);
    expect(channelNames(mirth.config)).toEqual(['Dev Only']);
  });

  it('refuses a backup from a newer Mirth version', async () => {
    const newer = await backupFile('vns-gov', '20260922T100000Z', ['Alpha'], { version: '4.6.0' });
    const r = await cli('restore', newer, '--yes');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('newer than this server (4.5.2)');
    expect(mirth.writes).toEqual([]);
  });

  it('keeps the backup being restored when rotation would drop it', async () => {
    const only = await backupFile('vns-gov', '20260920T100000Z', ['Alpha']);
    const r = await cli('restore', '--yes', '--keep', '1');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(only)).toBe(true);
  });

  it('says which servers it has backups of when this one has none', async () => {
    await backupFile('vns-dev', '20260922T100000Z', ['Dev Only'], { name: 'VNS Dev' });
    const r = await cli('restore', '--yes');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no backups of vns-gov');
    expect(r.stderr).toContain('it has backups of: vns-dev');
  });

  it('needs --yes without a terminal, before connecting', async () => {
    await backupFile('vns-gov', '20260921T100000Z', ['Alpha']);
    const r = await cli('restore');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pass --yes');
    expect(mirth.requests).toEqual([]);
  });
});
