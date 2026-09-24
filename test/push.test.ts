import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MirthClientExt } from '../src/client/index.js';
import { createExplodeEngine } from '../src/explode/index.js';
import { changedSince, librariesInSync, librariesToSend, planPush, resourceIds, type Plan } from '../src/push/index.js';
import { applyPlan, refreshRevisions } from '../src/push/apply.js';
import type { CanonicalConfig, Json } from '../src/types.js';

type Obj = Record<string, Json>;

const channel = (id: string, name: string, extra: Obj = {}): Obj => ({
  id,
  name,
  revision: 1,
  deployScript: 'return;',
  exportData: { metadata: { enabled: true, lastModified: { time: 1, timezone: 'GMT' }, userId: 1 } },
  ...extra,
});
const template = (id: string, name: string, code = `function ${name}() {}`): Obj => ({
  id,
  name,
  revision: 1,
  lastModified: { time: 1, timezone: 'GMT' },
  properties: { type: 'FUNCTION', code },
});
const library = (id: string, name: string, templates: Obj[], extra: Obj = {}): Obj => ({
  id,
  name,
  revision: 1,
  lastModified: { time: 1, timezone: 'GMT' },
  includeNewChannels: false,
  enabledChannelIds: { string: ['c1'] },
  disabledChannelIds: null,
  codeTemplates: { codeTemplate: templates },
  ...extra,
});

function server(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    channels: { channel: [channel('c1', 'Alpha'), channel('c2', 'Beta')] },
    codeTemplateLibraries: {
      codeTemplateLibrary: [
        library('L1', 'Formatting', [template('t1', 'pad'), template('t2', 'trim')]),
        library('L2', 'Routing', [template('t3', 'route')], { enabledChannelIds: { string: ['c2'] } }),
      ],
    },
    globalScripts: { entry: [{ string: ['Deploy', 'return;'] }] },
    channelGroups: { channelGroup: { id: 'g1', name: 'Group', channels: { channel: [{ id: 'c1' }] } } },
  };
}

const ch = (c: CanonicalConfig, i: number): Obj => ((c['channels'] as Obj)['channel'] as Obj[])[i]!;
const lib = (c: CanonicalConfig, i: number): Obj => ((c['codeTemplateLibraries'] as Obj)['codeTemplateLibrary'] as Obj[])[i]!;
const tpl = (c: CanonicalConfig, l: number, t: number): Obj => ((lib(c, l)['codeTemplates'] as Obj)['codeTemplate'] as Obj[])[t]!;
const summary = (p: Plan) => p.changes.map((c) => `${c.op} ${c.kind} ${c.label}`);

describe('planPush', () => {
  it('finds nothing when only volatile fields and line endings differ', () => {
    const local = server();
    ch(local, 0)['revision'] = 0;
    ((ch(local, 0)['exportData'] as Obj)['metadata'] as Obj)['lastModified'] = { time: 99, timezone: 'UTC' };
    ((ch(local, 0)['exportData'] as Obj)['metadata'] as Obj)['userId'] = 7;
    tpl(local, 0, 0)['lastModified'] = { time: 99, timezone: 'UTC' };
    const remote = server();
    ((tpl(local, 0, 1)['properties'] as Obj)['code']) = 'function trim() {\r\n}';
    ((tpl(remote, 0, 1)['properties'] as Obj)['code']) = 'function trim() {\n}';
    const plan = planPush(local, remote);
    expect(plan.changes).toEqual([]);
    expect(plan.notPushed).toEqual([]);
  });

  it('plans channel create, update and delete, and redeploys what changed', () => {
    const local = server();
    ch(local, 0)['deployScript'] = 'logger.info("x"); return;';
    ((local['channels'] as Obj)['channel'] as Obj[]).splice(1, 1, channel('c3', 'Gamma'));
    const plan = planPush(local, server());
    expect(summary(plan)).toEqual(['update channel Alpha', 'create channel Gamma', 'delete channel Beta']);
    expect(plan.deployIds).toEqual(['c1', 'c3']);
    expect(plan.conflicts).toEqual([]);
  });

  it('reports a conflict when the server revision is newer than the tree', () => {
    const local = server();
    ch(local, 0)['deployScript'] = 'changed';
    const remote = server();
    ch(remote, 0)['revision'] = 3;
    expect(planPush(local, remote).conflicts).toEqual(['channel "Alpha" (server revision 3, tree 1)']);
  });

  it('redeploys the channels a changed code template is enabled for', () => {
    const local = server();
    (tpl(local, 1, 0)['properties'] as Obj)['code'] = 'function route() { return 1; }';
    const plan = planPush(local, server());
    expect(summary(plan)).toEqual(['update codeTemplate Routing/route']);
    expect(plan.deployIds).toEqual(['c2']);
  });

  it('honours includeNewChannels minus disabled channels, and skips disabled channels', () => {
    const local = server();
    lib(local, 0)['includeNewChannels'] = true;
    lib(local, 0)['disabledChannelIds'] = { string: 'c1' };
    const remote = structuredClone(local);
    (tpl(local, 0, 0)['properties'] as Obj)['code'] = 'changed';
    expect(planPush(local, remote).deployIds).toEqual(['c2']);
    ((ch(local, 1)['exportData'] as Obj)['metadata'] as Obj)['enabled'] = false;
    expect(planPush(local, remote).deployIds).toEqual([]);
  });

  it('plans library membership changes with template create and delete', () => {
    const local = server();
    ((lib(local, 0)['codeTemplates'] as Obj)['codeTemplate'] as Obj[]).splice(1, 1, template('t9', 'fresh'));
    expect(summary(planPush(local, server()))).toEqual([
      'update library Formatting',
      'create codeTemplate Formatting/fresh',
      'delete codeTemplate Formatting/trim',
    ]);
  });

  it('plans a removed library as a library delete plus its template deletes', () => {
    const local = server();
    ((local['codeTemplateLibraries'] as Obj)['codeTemplateLibrary'] as Obj[]).splice(1, 1);
    expect(summary(planPush(local, server()))).toEqual(['delete library Routing', 'delete codeTemplate Routing/route']);
  });

  it('accepts Jackson single-element lists (a bare object instead of an array)', () => {
    const local = server();
    (local['channels'] as Obj)['channel'] = ch(local, 0);
    const remote = server();
    (remote['channels'] as Obj)['channel'] = ch(remote, 0);
    expect(planPush(local, remote).changes).toEqual([]);
  });

  it('limits the plan to --channel and leaves libraries and global scripts alone', () => {
    const local = server();
    ch(local, 0)['deployScript'] = 'changed';
    ch(local, 1)['deployScript'] = 'changed';
    (tpl(local, 0, 0)['properties'] as Obj)['code'] = 'changed';
    local['globalScripts'] = { entry: [] };
    ((local['channels'] as Obj)['channel'] as Obj[]).pop(); // Beta missing locally but out of scope
    const plan = planPush(local, server(), { channels: ['Alpha'] });
    expect(summary(plan)).toEqual(['update channel Alpha']);
    expect(plan.notPushed).toEqual([]);
  });

  it('rejects a --channel name that exists nowhere', () => {
    expect(() => planPush(server(), server(), { channels: ['Nope'] })).toThrow('no channel named "Nope"');
  });

  it('names differing sections it does not push', () => {
    const local = server();
    local['channelGroups'] = { channelGroup: { id: 'g1', name: 'Renamed', channels: '' } };
    local['configurationMap'] = { entry: [] };
    expect(planPush(local, server()).notPushed).toEqual(['channelGroups', 'configurationMap']);
  });

  it('sends the server copy of libraries outside a --library scope', () => {
    const local = server();
    lib(local, 0)['description'] = 'local edit';
    lib(local, 1)['description'] = 'out of scope edit';
    const sent = librariesToSend(local, server(), { libraries: ['Formatting'] }, planPush(local, server(), { libraries: ['Formatting'] }));
    expect(sent.map((l) => l['description'] ?? null)).toEqual(['local edit', null]);
  });
});

/** Records calls; `failOn` makes one call throw. */
function fakeClient(serverChannel: Obj | null = null, failOn?: string) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  const record = (name: string, body?: unknown) => {
    calls.push(name);
    bodies[name] = body;
    if (name === failOn) throw new Error('boom');
  };
  const client = {
    getChannel: async () => serverChannel,
    putChannel: async (c: Obj) => record(`putChannel ${c['id']}`, c),
    deleteChannel: async (id: string) => record(`deleteChannel ${id}`),
    putCodeTemplate: async (t: Obj) => record(`putCodeTemplate ${t['id']}`, t),
    deleteCodeTemplate: async (id: string) => record(`deleteCodeTemplate ${id}`),
    putCodeTemplateLibraries: async (libs: Obj[]) => record('putCodeTemplateLibraries', libs),
    putGlobalScripts: async (g: unknown) => record('putGlobalScripts', g),
  } as unknown as MirthClientExt;
  return { client, calls, bodies };
}

describe('applyPlan', () => {
  function bigChange(): CanonicalConfig {
    const local = server();
    ch(local, 0)['deployScript'] = 'changed';
    ((local['channels'] as Obj)['channel'] as Obj[]).pop();
    ((lib(local, 0)['codeTemplates'] as Obj)['codeTemplate'] as Obj[]).splice(1, 1, template('t9', 'fresh'));
    local['globalScripts'] = { entry: [] };
    return local;
  }

  it('creates templates before listing them, and deletes after unlisting', async () => {
    const local = bigChange();
    const plan = planPush(local, server());
    const { client, calls } = fakeClient();
    const result = await applyPlan(client, plan, local, server(), {});
    expect(calls).toEqual([
      'putCodeTemplate t9',
      'putCodeTemplateLibraries',
      'deleteCodeTemplate t2',
      'putChannel c1',
      'deleteChannel c2',
      'putGlobalScripts',
    ]);
    expect(result.failed).toBeUndefined();
    expect(result.applied).toHaveLength(plan.changes.length);
  });

  it("keeps the server's tags and dependencies on an updated channel", async () => {
    const local = server();
    ch(local, 0)['deployScript'] = 'changed';
    const tags = { channelTag: { id: 'tag1', channelIds: { string: ['c1'] } } };
    const { client, bodies } = fakeClient({ id: 'c1', exportData: { metadata: {}, channelTags: tags, dependencyIds: null } });
    await applyPlan(client, planPush(local, server()), local, server(), {});
    const sent = bodies['putChannel c1'] as Obj;
    expect((sent['exportData'] as Obj)['channelTags']).toEqual(tags);
    expect(((sent['exportData'] as Obj)['metadata'] as Obj)['enabled']).toBe(true);
    expect(sent['deployScript']).toBe('changed');
  });

  it('stops at the first failure and says what went through', async () => {
    const local = bigChange();
    const { client, calls } = fakeClient(null, 'deleteCodeTemplate t2');
    const result = await applyPlan(client, planPush(local, server()), local, server(), {});
    expect(calls.at(-1)).toBe('deleteCodeTemplate t2');
    expect(result.failed?.change.label).toBe('Formatting/trim');
    expect(result.applied.map((c) => c.id)).toEqual(['t9', 'L1']);
    expect(result.touchedIds.has('t9')).toBe(true);
  });
});

describe('tree maintenance', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'channelvault-push-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('refreshRevisions copies only revision fields for the pushed ids', async () => {
    const engine = createExplodeEngine();
    await engine.explode(server(), { root });
    const before = await readFile(path.join(root, 'channels', 'Beta', 'channel.json'), 'utf8');
    const after = server();
    ch(after, 0)['revision'] = 2;
    ((ch(after, 0)['exportData'] as Obj)['metadata'] as Obj)['lastModified'] = { time: 5, timezone: 'GMT' };
    tpl(after, 0, 0)['revision'] = 4;
    await refreshRevisions(root, after, new Set(['c1', 't1']));

    const alpha = JSON.parse(await readFile(path.join(root, 'channels', 'Alpha', 'channel.json'), 'utf8')) as Obj;
    expect(alpha['revision']).toBe(2);
    expect(((alpha['exportData'] as Obj)['metadata'] as Obj)['lastModified']).toEqual({ time: 5, timezone: 'GMT' });
    expect(alpha['deployScript']).toEqual({ '@file': 'scripts/deploy.js' });
    const formatting = JSON.parse(await readFile(path.join(root, 'codeTemplates', 'Formatting', 'library.json'), 'utf8')) as Obj;
    expect((((formatting['codeTemplates'] as Obj)['codeTemplate'] as Obj[])[0]!)['revision']).toBe(4);
    expect(formatting['revision']).toBe(1);
    expect(await readFile(path.join(root, 'channels', 'Beta', 'channel.json'), 'utf8')).toBe(before);
  });

  it('implode treats a deleted channel directory as a deleted channel', async () => {
    const engine = createExplodeEngine();
    await engine.explode(server(), { root });
    await rm(path.join(root, 'channels', 'Beta'), { recursive: true });
    const imploded = await engine.implode({ root });
    expect(((imploded['channels'] as Obj)['channel'] as Obj[]).map((c) => c['name'])).toEqual(['Alpha']);
  });

  it('implode still fails on a missing script file', async () => {
    const engine = createExplodeEngine();
    await engine.explode(server(), { root });
    await rm(path.join(root, 'channels', 'Alpha', 'scripts', 'deploy.js'));
    await expect(engine.implode({ root })).rejects.toThrow(/ENOENT/);
  });

  it('keeps writing JSON in the explode format', async () => {
    await mkdir(path.join(root, 'channels', 'X'), { recursive: true });
    const json = { id: 'c1', revision: 1 };
    await writeFile(path.join(root, 'channels', 'X', 'channel.json'), JSON.stringify(json, null, 2));
    const after = server();
    ch(after, 0)['revision'] = 9;
    await refreshRevisions(root, after, new Set(['c1']));
    expect(await readFile(path.join(root, 'channels', 'X', 'channel.json'), 'utf8')).toBe(
      JSON.stringify({ id: 'c1', revision: 9 }, null, 2),
    );
  });
});

describe('code review regressions', () => {
  it('refuses a --library push that moves a template across the scope boundary', () => {
    const local = server();
    const moved = ((lib(local, 0)['codeTemplates'] as Obj)['codeTemplate'] as Obj[]).splice(1, 1)[0]!;
    ((lib(local, 1)['codeTemplates'] as Obj)['codeTemplate'] as Obj[]).push(moved);
    expect(() => planPush(local, server(), { libraries: ['Routing'] })).toThrow(
      'code template "trim" moved from "Formatting" to "Routing"; include both with --library',
    );
    // Both libraries in scope: a normal move.
    expect(summary(planPush(local, server(), { libraries: ['Routing', 'Formatting'] }))).toEqual([
      'update library Formatting',
      'update library Routing',
    ]);
  });

  it('leaves server resources the tree never had alone instead of deleting them', () => {
    const remote = server();
    ((remote['channels'] as Obj)['channel'] as Obj[]).push(channel('c9', 'Created Later'));
    const known = resourceIds(server());
    const plan = planPush(server(), remote, {}, known);
    expect(plan.changes).toEqual([]);
    expect(plan.serverOnly).toEqual(['channel "Created Later"']);
    // A resource the tree had and lost is still a delete.
    const local = server();
    ((local['channels'] as Obj)['channel'] as Obj[]).pop();
    expect(summary(planPush(local, remote, {}, known))).toEqual(['delete channel Beta']);
  });

  it('refreshes only in-scope and already-in-sync libraries after a library-list PUT', async () => {
    const local = server();
    (tpl(local, 0, 0)['properties'] as Obj)['code'] = 'changed';
    lib(local, 0)['description'] = 'membership-level edit';
    const remote = server();
    lib(remote, 1)['description'] = 'a colleague edited Routing';
    lib(remote, 1)['revision'] = 5;
    const scope = { libraries: ['Formatting'] };
    const { client } = fakeClient();
    const result = await applyPlan(client, planPush(local, remote, scope), local, remote, scope);
    expect(result.touchedIds.has('L1')).toBe(true);
    expect(result.touchedIds.has('L2')).toBe(false); // stale: keeps its conflict for next time
    expect(librariesInSync(server(), server())).toEqual(['L1', 'L2']);
  });

  it('implode drops a deleted directory even when it was the only member', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'channelvault-single-'));
    try {
      const single = server();
      (single['channels'] as Obj)['channel'] = ch(single, 0); // Jackson single-element shape
      const engine = createExplodeEngine();
      await engine.explode(single, { root });
      await rm(path.join(root, 'channels', 'Alpha'), { recursive: true });
      const imploded = await engine.implode({ root });
      expect(planPush(imploded, single).changes.map((c) => `${c.op} ${c.label}`)).toEqual(['delete Alpha']);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects --whole-server combined with --channel before touching a server', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(repo, 'src', 'cli.ts'), 'push', repo, '--whole-server', '--channel', 'X'],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--whole-server replaces everything');
  });
});

it('ignores tag and dependency fields that Mirth flips between absent and null', () => {
  const remote = server();
  Object.assign(ch(remote, 0)['exportData'] as Obj, { channelTags: null, dependentIds: null, dependencyIds: null });
  expect(planPush(server(), remote).changes).toEqual([]);
});

it('treats a lone CR like any other line ending (Mirth rewrites both as LF on save)', () => {
  const local = server();
  ch(local, 0)['deployScript'] = '// ack\rhl7Listener(msg);';
  const remote = server();
  ch(remote, 0)['deployScript'] = '// ack\nhl7Listener(msg);';
  expect(planPush(local, remote).changes).toEqual([]);
});

describe('second review regressions', () => {
  it('keeps a library created on the server since the pull when another library changes', () => {
    const remote = server();
    ((remote['codeTemplateLibraries'] as Obj)['codeTemplateLibrary'] as Obj[]).push(library('L9', 'Theirs', []));
    const local = server();
    lib(local, 0)['description'] = 'changed';
    const known = resourceIds(server());
    const plan = planPush(local, remote, {}, known);
    expect(plan.serverOnly).toEqual(['library "Theirs"']);
    expect(librariesToSend(local, remote, {}, plan).map((l) => l['id'])).toEqual(['L1', 'L2', 'L9']);
  });

  it('redeploys channels that lose a library, and those of a deleted library', () => {
    const local = server();
    lib(local, 1)['enabledChannelIds'] = { string: ['c1'] }; // Routing moves from c2 to c1
    expect(planPush(local, server()).deployIds.sort()).toEqual(['c1', 'c2']);
    const without = server();
    ((without['codeTemplateLibraries'] as Obj)['codeTemplateLibrary'] as Obj[]).pop(); // delete Routing (c2)
    expect(planPush(without, server()).deployIds).toEqual(['c2']);
  });

  it('refuses when a planned resource changed while the push was being confirmed', () => {
    const local = server();
    ch(local, 0)['deployScript'] = 'changed';
    const plan = planPush(local, server());
    const after = server();
    ch(after, 0)['revision'] = 2;
    expect(changedSince(plan, server(), after)).toEqual(['channel "Alpha"']);
    expect(changedSince(plan, server(), server())).toEqual([]);
  });

  it('refuses a channel save when the server revision moved after planning', async () => {
    const local = server();
    ch(local, 0)['deployScript'] = 'changed';
    const { client, calls } = fakeClient({ id: 'c1', revision: 2, exportData: { metadata: {} } });
    const result = await applyPlan(client, planPush(local, server()), local, server(), {});
    expect(result.failed?.error).toMatch(/changed on the server during the push \(revision 2, planned against 1\)/);
    expect(calls).toEqual([]);
    const forced = await applyPlan(fakeClient({ id: 'c1', revision: 2, exportData: {} }).client, planPush(local, server()), local, server(), {}, { force: true });
    expect(forced.failed).toBeUndefined();
  });
});

describe('filesystem safety', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'channelvault-fs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('keeps channels whose names differ only in case apart', async () => {
    const cfg = server();
    ch(cfg, 1)['name'] = 'alpha'; // "Alpha" and "alpha"
    const engine = createExplodeEngine();
    await engine.explode(cfg, { root });
    expect(await engine.implode({ root })).toEqual(cfg);
  });

  it('rejects a marker that reaches outside the tree through a junction or symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'channelvault-outside-'));
    try {
      await writeFile(path.join(outside, 'deploy.js'), 'OUTSIDE');
      const engine = createExplodeEngine();
      await engine.explode(server(), { root });
      const scripts = path.join(root, 'channels', 'Alpha', 'scripts');
      await rm(scripts, { recursive: true });
      await symlink(outside, scripts, 'junction');
      await expect(engine.implode({ root })).rejects.toThrow(/escapes the working tree through a link/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
