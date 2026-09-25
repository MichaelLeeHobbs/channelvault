/**
 * Regressions for the third review: stale library snapshots, script-path
 * escapes, deletes of changed resources, whole-server deletion consent,
 * truncated XML, redeploys of server-only channels, duplicate env lines.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExplodeEngine } from '../src/explode/index.js';
import { changedSince, librariesToSend, planPush, resourceIds } from '../src/push/index.js';
import { readEnvFile, updateEnvFile } from '../src/secrets/envfile.js';
import { XmlConfigAdapter } from '../src/xml/index.js';
import type { CanonicalConfig, Json } from '../src/types.js';
import { startFakeMirth } from './helpers/fakeMirth.js';

type Obj = Record<string, Json>;

const channel = (id: string, name: string, extra: Obj = {}): Obj => ({
  id,
  name,
  revision: 1,
  deployScript: 'return;',
  exportData: { metadata: { enabled: true } },
  ...extra,
});
const library = (id: string, name: string, templates: Obj[], extra: Obj = {}): Obj => ({
  id,
  name,
  revision: 1,
  includeNewChannels: false,
  enabledChannelIds: { string: ['c1'] },
  disabledChannelIds: null,
  codeTemplates: { codeTemplate: templates },
  ...extra,
});
const template = (id: string, name: string): Obj => ({ id, name, revision: 1, properties: { type: 'FUNCTION', code: `function ${name}() {}` } });

function server(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    channels: { channel: [channel('c1', 'Alpha')] },
    codeTemplateLibraries: {
      codeTemplateLibrary: [library('L1', 'Formatting', [template('t1', 'pad')]), library('L2', 'Routing', [template('t2', 'route')])],
    },
    globalScripts: { entry: [{ string: ['Deploy', 'return;'] }] },
  };
}
const libs = (c: CanonicalConfig): Obj[] => (c['codeTemplateLibraries'] as Obj)['codeTemplateLibrary'] as Obj[];
const chans = (c: CanonicalConfig): Obj[] => (c['channels'] as Obj)['channel'] as Obj[];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-r3-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('1. library pushes use a fresh snapshot', () => {
  it('stops when any library changed or appeared while confirming, and sends the fresh ones', () => {
    const local = server();
    libs(local)[0]!['description'] = 'L1 edit';
    const scope = { libraries: ['Formatting'] };
    const plan = planPush(local, server(), scope);
    const fresh = server();
    libs(fresh)[1]!['revision'] = 2; // L2 edited meanwhile
    libs(fresh).push(library('L3', 'New', [])); // L3 created meanwhile
    expect(changedSince(plan, server(), fresh)).toContain('code template libraries (the library list is saved as a whole)');
    // With --force the payload still carries the fresh L2 and keeps L3.
    const sent = librariesToSend(local, fresh, scope, plan);
    expect(sent.map((l) => `${l['id']}@${l['revision']}`)).toEqual(['L1@1', 'L2@2', 'L3@1']);
  });
});

describe('2. explode never writes outside the tree', () => {
  it('keeps a key with path segments inside _code', async () => {
    const cfg: CanonicalConfig = {
      channels: { channel: [channel('c1', 'Alpha', { extension: { 'x/../../../../../../escaped': { script: 'evil();' } } })] },
    };
    const root = path.join(dir, 'tree');
    await createExplodeEngine().explode(cfg, { root });
    expect(await readdir(dir)).toEqual(['tree']);
    expect(await createExplodeEngine().implode({ root })).toEqual(cfg);
  });

  it('refuses to write through a junction or symlink inside the tree', async () => {
    const root = path.join(dir, 'tree');
    const outside = path.join(dir, 'outside');
    await mkdir(path.join(root), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(root, 'channels'), 'junction');
    await expect(createExplodeEngine().explode(server(), { root })).rejects.toThrow(/refusing to write outside the working tree/);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('3. deleting a resource the server changed since the pull', () => {
  it('is a conflict, not just a delete', () => {
    const known = resourceIds(server()); // pulled at revision 1
    const remote = server();
    chans(remote).push(channel('c2', 'Beta'));
    known.channels['c2'] = 1;
    chans(remote)[1]!['revision'] = 25; // edited on the server after the pull
    const plan = planPush(server(), remote, {}, known); // c2 deleted locally
    expect(plan.changes.map((c) => `${c.op} ${c.id}`)).toEqual(['delete c2']);
    expect(plan.conflicts).toEqual(['channel "Beta" changed on the server since the last pull (revision 25, pulled 1); deleting it would discard that']);
  });

  it('compares global scripts with the hash taken at the last sync', () => {
    const known = resourceIds(server());
    const remote = server();
    remote['globalScripts'] = { entry: [{ string: ['Deploy', 'colleague();'] }] };
    const local = server();
    local['globalScripts'] = { entry: [{ string: ['Deploy', 'mine();'] }] };
    expect(planPush(local, remote, {}, known).conflicts).toEqual(['global scripts changed on the server since the last pull']);
  });
});

describe('4. --whole-server needs deletion consent for server-only resources', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const cli = (args: string[], env: Record<string, string>) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli.ts'), ...args], {
        cwd: repo,
        env: { ...process.env, ...env },
      });
      let out = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString()));
      p.stderr.on('data', (d: Buffer) => (out += d.toString()));
      p.on('close', (status) => resolve({ status, out }));
    });

  it('names the server-only channel and refuses without --allow-deletes, even with --force', async () => {
    const mirth = await startFakeMirth(server());
    try {
      const tree = path.join(dir, 'tree');
      const env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
      expect((await cli(['pull', tree, '--no-https'], env)).status).toBe(0);
      chans(mirth.config).push(channel('c2', 'Created Later'));

      const refused = await cli(['push', tree, '--whole-server', '--force', '--yes', '--no-https'], env);
      expect(refused.status).toBe(1);
      expect(refused.out).toContain('delete  channel "Created Later" (created on the server since the last pull)');
      expect(refused.out).toContain('pass --allow-deletes');
      expect(mirth.writes).toEqual([]);

      const allowed = await cli(['push', tree, '--whole-server', '--force', '--allow-deletes', '--yes', '--no-https'], env);
      expect(allowed.status, allowed.out).toBe(0);
      expect(mirth.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PUT /api/server/configuration']);
    } finally {
      await mirth.close();
    }
  });
});

describe('5. a truncated XML backup is rejected before anything is written', () => {
  it('fails to parse', () => {
    expect(() => new XmlConfigAdapter().parse('<serverConfiguration version="4.5.2"><channels></serverConfiguration>')).toThrow(
      /not well-formed XML/,
    );
  });

  it('leaves an existing tree untouched', async () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const fixture = path.join(repo, 'test', 'fixtures', 'serverConfiguration.sample.xml');
    const tree = path.join(dir, 'tree');
    const run = (xml: string) =>
      new Promise<number | null>((resolve) => {
        const p = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli.ts'), 'explode', xml, tree], { cwd: repo });
        p.on('close', resolve);
      });
    expect(await run(fixture)).toBe(0);
    const before = (await readdir(path.join(tree, 'channels'))).length;
    const truncated = path.join(dir, 'truncated.xml');
    const full = await readFile(fixture, 'utf8');
    // Cut at a tag boundary, closing the root: the old parser accepted this as a config with no channels.
    await writeFile(truncated, `${full.slice(0, full.indexOf('<channels>') + '<channels>'.length)}\n</serverConfiguration>\n`);
    expect(await run(truncated)).toBe(1);
    expect((await readdir(path.join(tree, 'channels'))).length).toBe(before);
    expect(existsSync(path.join(tree, '.channelvault-staging'))).toBe(false);
  });
});

describe('6. library redeploys include channels created on the server', () => {
  it('uses the channels as they will be after the push', () => {
    const local = server();
    libs(local)[0]!['includeNewChannels'] = true;
    (((libs(local)[0]!['codeTemplates'] as Obj)['codeTemplate'] as Obj[])[0]!['properties'] as Obj)['code'] = 'changed';
    const remote = structuredClone(server());
    libs(remote)[0]!['includeNewChannels'] = true;
    chans(remote).push(channel('c2', 'Created Later'));
    expect(planPush(local, remote, {}, resourceIds(server())).deployIds.sort()).toEqual(['c1', 'c2']);
  });
});

describe('7. env file updates', () => {
  it('replaces every assignment of a name (dotenv uses the last one)', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'PASSWORD=old-first\nOTHER=x\nPASSWORD=old-effective\n');
    await updateEnvFile(file, { PASSWORD: 'rotated' });
    expect(await readEnvFile(file)).toEqual({ PASSWORD: 'rotated', OTHER: 'x' });
  });

  it('does not treat a line inside another multi-line value as an assignment', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'NOTE="first line\nPASSWORD=inside-the-note\nlast line"\nPASSWORD=real\n');
    await updateEnvFile(file, { PASSWORD: 'rotated' });
    expect(await readEnvFile(file)).toEqual({ NOTE: 'first line\nPASSWORD=inside-the-note\nlast line', PASSWORD: 'rotated' });
  });
});
