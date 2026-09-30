import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createExplodeEngine } from '../src/explode/index.js';
import { channelsOf, librariesOf } from '../src/push/index.js';
import type { Json } from '../src/types.js';

const engine = createExplodeEngine();
let dir: string, root: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-additions-'));
  root = path.join(dir, 'tree');
  await engine.explode({ '@version': '4.5.2', channels: { channel: { id: 'c1', name: 'Alpha', revision: 1, deployScript: 'return;' } } }, { root });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

it('includes a copied channel with a new ID and resolves its code without skeleton edits', async () => {
  const skeleton = await readFile(path.join(root, 'server', 'configuration.json'), 'utf8');
  const copy = path.join(root, 'channels', 'Beta');
  await cp(path.join(root, 'channels', 'Alpha'), copy, { recursive: true });
  const channel = JSON.parse(await readFile(path.join(copy, 'channel.json'), 'utf8'));
  channel.id = 'c2'; channel.name = 'Beta'; channel.revision = 0;
  await writeFile(path.join(copy, 'channel.json'), JSON.stringify(channel));
  await writeFile(path.join(copy, 'scripts', 'deploy.js'), 'beta();');
  const config = await engine.implode({ root });
  expect(channelsOf(config).map(c => c.id)).toEqual(['c1', 'c2']);
  expect(channelsOf(config)[1]!.deployScript).toBe('beta();');
  expect(await engine.implode({ root })).toEqual(config);
  expect(await readFile(path.join(root, 'server', 'configuration.json'), 'utf8')).toBe(skeleton);
});

it('refuses a copied channel with the source ID instead of ignoring it', async () => {
  await cp(path.join(root, 'channels', 'Alpha'), path.join(root, 'channels', 'Beta'), { recursive: true });
  await expect(engine.implode({ root })).rejects.toThrow('give each copy a new UUID');
});

it('keeps a channel when its directory is renamed', async () => {
  await rename(path.join(root, 'channels', 'Alpha'), path.join(root, 'channels', 'Moved'));
  expect(channelsOf(await engine.implode({ root })).map(c => c.id)).toEqual(['c1']);
});

it.each([null, '', {}, { channel: [] }] as Json[])('discovers the first channel in an empty collection %j', async channels => {
  await rm(path.join(root, 'channels'), { recursive: true });
  await engine.explode({ '@version': '4.5.2', channels }, { root });
  const folder = path.join(root, 'channels', 'New');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'channel.json'), JSON.stringify({ id: 'new', name: 'New', revision: 0 }));
  const config = await engine.implode({ root });
  expect(channelsOf(config).map(c => c.id)).toEqual(['new']);
  expect(config.channels).toEqual({ channel: { id: 'new', name: 'New', revision: 0 } });
});

it('discovers new libraries and groups when their skeleton collections are absent', async () => {
  await mkdir(path.join(root, 'codeTemplates', 'Helpers'), { recursive: true });
  await writeFile(path.join(root, 'codeTemplates', 'Helpers', 'library.json'), JSON.stringify({ id: 'L1', name: 'Helpers', codeTemplates: { codeTemplate: { id: 't1', name: 'one', properties: { code: { '@file': 'one.js' } } } } }));
  await writeFile(path.join(root, 'codeTemplates', 'Helpers', 'one.js'), 'function one() {}');
  await mkdir(path.join(root, 'channelGroups'));
  await writeFile(path.join(root, 'channelGroups', 'New.json'), JSON.stringify({ id: 'g1', name: 'New', channels: { channel: { id: 'c1' } } }));
  const config = await engine.implode({ root });
  expect(librariesOf(config)[0]!.codeTemplates).toEqual({ codeTemplate: { id: 't1', name: 'one', properties: { code: 'function one() {}' } } });
  expect(config.channelGroups).toEqual({ channelGroup: { id: 'g1', name: 'New', channels: { channel: { id: 'c1' } } } });
});

it('refuses a new resource missing identity metadata', async () => {
  await mkdir(path.join(root, 'channels', 'Bad'));
  await writeFile(path.join(root, 'channels', 'Bad', 'channel.json'), '{}');
  await expect(engine.implode({ root })).rejects.toThrow('needs a nonempty id and name');
});

it('refuses discovery through a junction outside the tree', async () => {
  const outside = path.join(dir, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'channel.json'), JSON.stringify({ id: 'c9', name: 'Outside' }));
  await symlink(outside, path.join(root, 'channels', 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(engine.implode({ root })).rejects.toThrow('resource path escapes the working tree through a link');
});
