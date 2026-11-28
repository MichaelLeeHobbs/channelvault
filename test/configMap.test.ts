import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BASELINES_DIR, readConfigMapBaseline, writeConfigMapBaseline } from '../src/configMapBaselines.js';
import {
  baselineAfterPush, configMapBaseline, mergeConfigMap, planConfigMap, sameConfigMap, UnknownConfigMapKey, withSortedConfigMap,
} from '../src/push/configMap.js';
import { planPush } from '../src/push/index.js';
import type { CanonicalConfig, Json } from '../src/types.js';

type Obj = Record<string, Json>;
const PROPERTY = 'com.mirth.connect.util.ConfigurationProperty';
const entry = (key: string, value: string, comment: string | null = null): Obj => ({ string: key, [PROPERTY]: { value, comment } });
const map = (...entries: Obj[]): CanonicalConfig => ({ configurationMap: { '@class': 'linked-hash-map', entry: entries } });

describe('configuration-map baseline', () => {
  it('records a hash per key, never the value, and differs for two keys holding one value', () => {
    const baseline = configMapBaseline(map(entry('A', 'secret-value'), entry('B', 'secret-value')));
    expect(JSON.stringify(baseline)).not.toContain('secret-value');
    expect(Object.keys(baseline)).toEqual(['A', 'B']);
    expect(baseline['A']).not.toBe(baseline['B']);
  });

  it('ignores line-ending differences, as push does elsewhere', () => {
    expect(configMapBaseline(map(entry('A', 'x\r\ny')))).toEqual(configMapBaseline(map(entry('A', 'x\ny'))));
  });

  it('reads a value Mirth answers as a boolean or number, and an empty comment as null, as the same entry', () => {
    const typed: Obj = { string: 'A', [PROPERTY]: { value: true, comment: null } };
    const port: Obj = { string: 'B', [PROPERTY]: { value: 5, comment: '' } };
    expect(planConfigMap(map(entry('A', 'true', ''), entry('B', '5')), map(typed, port), ['A', 'B'], undefined).unchanged).toEqual(['A', 'B']);
  });

  it('is not extended when there is none', () => {
    expect(baselineAfterPush(undefined, map(entry('A', 'new')), ['A'])).toBeUndefined();
  });

  it('after a push, takes the named keys from the server and keeps the rest', () => {
    const before = configMapBaseline(map(entry('A', 'a'), entry('B', 'b')));
    const after = baselineAfterPush(before, map(entry('A', 'new'), entry('B', 'edited-by-someone')), ['A'])!;
    expect(after['B']).toBe(before['B']);
    expect(after['A']).toBe(configMapBaseline(map(entry('A', 'new')))['A']);
  });
});

describe('planConfigMap', () => {
  const server = map(entry('A', 'a'), entry('B', 'b'));
  const baseline = configMapBaseline(server);

  it('plans create, update and delete, and leaves matching keys alone', () => {
    const remote = map(entry('A', 'a'), entry('B', 'b'), entry('D', 'd'));
    const plan = planConfigMap(map(entry('A', 'a'), entry('B', 'b2'), entry('C', 'c')), remote, ['A', 'B', 'C', 'D'], configMapBaseline(remote));
    expect(plan.changes.map((c) => `${c.op} ${c.id}`)).toEqual(['update B', 'create C', 'delete D']);
    expect(plan.unchanged).toEqual(['A']);
    expect(plan.conflicts).toEqual([]);
  });

  it('treats a comment change as a change', () => {
    expect(planConfigMap(map(entry('A', 'a', 'note')), server, ['A'], baseline).changes).toHaveLength(1);
  });

  it('reports a server edit, creation or deletion since the baseline', () => {
    const tree = map(entry('A', 'mine'), entry('B', 'mine'), entry('N', 'mine'));
    const now = map(entry('A', 'theirs'), entry('N', 'theirs'));
    expect(planConfigMap(tree, now, ['A', 'B', 'N'], baseline).conflicts).toEqual([
      'configuration-map key "A" changed on the server since the last pull',
      'configuration-map key "B" was deleted on the server since the last pull',
      'configuration-map key "N" was created on the server since the last pull',
    ]);
  });

  it('cannot check a key without a baseline', () => {
    expect(planConfigMap(map(entry('A', 'mine')), server, ['A'], undefined).conflicts[0]).toContain('no configuration-map baseline');
  });

  it('refuses a key that is in neither the tree nor the server', () => {
    expect(() => planConfigMap(server, server, ['X'], baseline)).toThrow(UnknownConfigMapKey);
  });
});

// Mirth holds the map in a hash map: a key added at the end reads back elsewhere.
describe('configuration-map order', () => {
  const a = map(entry('A', 'a'), entry('B', 'b'));
  const b = map(entry('B', 'b'), entry('A', 'a'));

  it('does not count as a difference', () => {
    expect(sameConfigMap(a, b)).toBe(true);
    expect(sameConfigMap({}, { configurationMap: { entry: [] } })).toBe(true);
    expect(planPush(a, b).notPushed).toEqual([]);
    expect(planPush(a, map(entry('A', 'a'))).notPushed).toEqual(['configurationMap']);
  });

  it('is put in key order for display', () => {
    expect(withSortedConfigMap(b)).toEqual(a);
    expect(withSortedConfigMap({ configurationMap: { entry: entry('A', 'a') } })).toEqual({ configurationMap: { entry: [entry('A', 'a')] } });
  });
});

describe('mergeConfigMap', () => {
  it('keeps the server\'s other entries, order and holder fields', () => {
    const server = map(entry('A', 'a'), entry('B', 'server-b'), entry('C', 'c'));
    const tree = map(entry('A', 'tree-a'), entry('B', 'tree-b'), entry('N', 'n'));
    expect(mergeConfigMap(server, tree, ['A', 'N'])).toEqual({
      '@class': 'linked-hash-map',
      entry: [entry('A', 'tree-a'), entry('B', 'server-b'), entry('C', 'c'), entry('N', 'n')],
    });
  });

  it('accepts a single entry written as a bare object', () => {
    const server: CanonicalConfig = { configurationMap: { entry: entry('A', 'a') } };
    expect(mergeConfigMap(server, map(entry('N', 'n')), ['N'])['entry']).toEqual([entry('A', 'a'), entry('N', 'n')]);
  });

  it('drops a named key the tree no longer has', () => {
    expect(mergeConfigMap(map(entry('A', 'a'), entry('B', 'b')), map(entry('A', 'a')), ['B'])['entry']).toEqual([entry('A', 'a')]);
  });
});

describe('configuration-map baseline store', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'channelvault-baselines-'));
    saved = process.env.CHANNELVAULT_CONFIG_DIR;
    process.env.CHANNELVAULT_CONFIG_DIR = path.join(dir, 'config');
  });
  afterEach(async () => {
    process.env.CHANNELVAULT_CONFIG_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps one baseline per installation, under a file name an installation ID cannot steer', async () => {
    await writeConfigMapBaseline('../../escape', { A: 'h1' });
    await writeConfigMapBaseline('mirth-gov', { B: 'h2' });
    expect(await readConfigMapBaseline('../../escape')).toEqual({ A: 'h1' });
    expect(await readConfigMapBaseline('mirth-gov')).toEqual({ B: 'h2' });
    expect(await readConfigMapBaseline('other')).toBeUndefined();
    const files = await import('node:fs/promises').then((fs) => fs.readdir(path.join(dir, 'config', BASELINES_DIR)));
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).toMatch(/^[0-9a-f]{32}\.json$/);
    expect(await readFile(path.join(dir, 'config', BASELINES_DIR, files[0]!), 'utf8')).toContain('"serverId"');
  });
});
