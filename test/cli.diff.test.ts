/**
 * Differences between servers that are representation, not content: what a
 * tree pulled from one installation must not report against another.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanonicalConfig, Json } from '../src/types.js';
import { runCli } from './helpers/cli.js';
import { startFakeMirth, type FakeMirth } from './helpers/fakeMirth.js';

type Obj = Record<string, Json>;

const CONTEXTS = ['SOURCE_RECEIVER', 'DESTINATION_FILTER_TRANSFORMER', 'DESTINATION_DISPATCHER', 'SOURCE_FILTER_TRANSFORMER'];

function fixture(): CanonicalConfig {
  return {
    '@version': '4.5.2',
    channels: { channel: [{
      id: 'c1', name: 'Alpha', revision: 1, deployScript: 'return;',
      exportData: { metadata: { enabled: true } },
    }] },
    codeTemplateLibraries: { codeTemplateLibrary: [{
      id: 'l1', name: 'Lib', revision: 1, includeNewChannels: false,
      enabledChannelIds: { string: ['c1'] }, disabledChannelIds: null,
      codeTemplates: { codeTemplate: [{
        id: 't1', name: 'trim', revision: 1,
        contextSet: { delegate: { contextType: [...CONTEXTS] } },
        properties: { type: 'FUNCTION', code: 'function trim() {}' },
      }] },
    }] },
  };
}

let dir: string, tree: string, mirth: FakeMirth, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'channelvault-diff-'));
  tree = path.join(dir, 'tree');
  mirth = await startFakeMirth(fixture());
  env = { MIRTH_HOST: '127.0.0.1', MIRTH_PORT: String(mirth.port), MIRTH_USER: 'u', MIRTH_PASS: 'p' };
  const pull = await runCli(['pull', tree, '--no-https'], env);
  expect(pull.status, pull.stderr).toBe(0);
});
afterEach(async () => {
  await mirth?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const run = (...args: string[]) => runCli([...args, '--no-https'], env);
const serverTemplate = (): Obj => {
  const libs = (mirth.config['codeTemplateLibraries'] as { codeTemplateLibrary: Obj[] }).codeTemplateLibrary;
  return ((libs[0]!['codeTemplates'] as Obj)['codeTemplate'] as Obj[])[0]!;
};
const serverExportData = (): Obj => (mirth.config['channels'] as { channel: Obj[] }).channel[0]!['exportData'] as Obj;

describe('diff and push across representations', () => {
  // Mirth holds context types in a Java set; another server lists them in another order (seen on 4.5.0).
  it('compares a code template\'s context types as a set', async () => {
    serverTemplate()['contextSet'] = { delegate: { contextType: [...CONTEXTS].reverse() } };

    const diff = await run('diff', tree, '--json');
    expect(diff.status, diff.stdout).toBe(0);
    expect(JSON.parse(diff.stdout)).toMatchObject({ clean: true, files: [] });

    const plan = await run('push', tree, '--plan-only', '--backup-dir', path.join(dir, 'backups'));
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).not.toMatch(/update\s+code template/);
  });

  it('still reports a context type that was added or removed', async () => {
    serverTemplate()['contextSet'] = { delegate: { contextType: CONTEXTS.slice(1) } };
    const diff = await run('diff', tree, '--json');
    expect(diff.status).toBe(1);
  });

  // Mirth flips these between absent and null after unrelated saves.
  it('treats null channel tags and dependency links as absent', async () => {
    Object.assign(serverExportData(), { channelTags: null, dependentIds: null, dependencyIds: null });
    const diff = await run('diff', tree, '--json');
    expect(diff.status, diff.stdout).toBe(0);
    expect(JSON.parse(diff.stdout)).toMatchObject({ clean: true, files: [] });
  });

  it('still reports channel tags that hold something', async () => {
    serverExportData()['channelTags'] = { channelTag: [{ id: 'g1', name: 'lab', channelIds: { string: ['c1'] } }] };
    const diff = await run('diff', tree, '--json');
    expect(diff.status).toBe(1);
  });
});

describe('a code template holding a character XML 1.0 forbids', () => {
  // The production incident: U+FFFE in a regex inside a code template.
  it('is refused before any backup or save, naming the template and its file', async () => {
    await writeFile(path.join(tree, 'codeTemplates', 'Lib', 'trim.js'), 'function trim() { return /[\uFFFE]/; }');
    const result = await run('push', tree, '--yes', '--backup-dir', path.join(dir, 'backups'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Lib › trim › code: line 1, column 28 of the value (U+FFFE)');
    expect(result.stderr).toContain('codeTemplates/Lib/trim.js:1:28 (U+FFFE)');
    expect(mirth.writes).toEqual([]);
  });
});
